/**
 * The **Manual annotations** card (spec §8.1): the marks a reader draws
 * themselves.
 *
 * Two ways in for each kind, because the two are wanted at different moments.
 * Typing coordinates is what you do when you already know them — from a paper,
 * from a table, from the readout you just copied. Clicking the map is what you
 * do when you are looking at the thing and want to point at it. Neither is a
 * fallback for the other, so both are first-class and both produce exactly the
 * same mark.
 *
 * Three kinds, and they are three sentences: a line says *this coordinate*, an
 * arrowhead says *this cell*, a rectangle says *this block of contacts*.
 */

import {
  MANUAL_PALETTE,
  describeMark,
  isShown,
  mintMarkId,
  pointLabel,
  spanLabel,
  parsePoint,
  parseSpan,
  type LineAxis,
  type ManualMark,
  type ManualPoint,
  type ManualSpan,
  type ManualStore,
} from '../annotations/manual'
import { formatMarks, marksFor, readMarks, type MarkFormat } from '../annotations/export'
import { filesFrom } from './chooseFiles'
import { KEYS, withKey } from './commands'
import { button, dragHasFiles, el, fmt } from './dom'
import { TAB_WALKS, tabStep } from './tabWalk'
import { downloadBlob, exportBaseName, fileStamp } from './export'
import { exportRow, type ExportRow } from './exportRow'
import { cardTitle, icon, iconButton, setPressed } from './icons'
import type { PickHandlers } from './mapPick'

/**
 * How the card reaches the mounted plot.
 *
 * An interface rather than a reference, because the card lives in the shell's
 * sidebar and the plot is inside whichever view is mounted — which changes under
 * it. The shell implements this by forwarding to whatever is on screen, and a
 * card that is up while nothing is answers by disabling its own buttons.
 */
export interface MapPicker {
  /** `true` when there is a plot to click on. */
  available(): boolean
  /**
   * What kind of picture the picks would land on, when there is one.
   *
   * The card says *pick on map* beside a contact map and *pick on track* in the
   * 1D genome browser, because those are two different things to point at and a
   * button that named the one that is not on screen would be asking the reader
   * to look for it. Absent — or a shell that does not answer — means a map,
   * which is what every caller meant before there was anything else to pick on.
   *
   * Read on every {@link ManualCard.refresh}, not captured: the card lives in
   * the sidebar and the picture under it is replaced on every navigation, so
   * this is a question about *now* rather than a property of the picker.
   */
  surface?(): PickSurface
  /**
   * Turn on picking, for as long as the mode lasts.
   *
   * Which gesture the mode listens for is decided by what the form hands over:
   * `point` takes every click as one locus per axis, `box` takes every drag as
   * one stretch per axis ({@link PickHandlers}).
   *
   * `onEnd` fires exactly once, however the mode ends — the returned stop
   * function, Escape, another gesture arming over this one, or the plot going
   * away underneath it. That is what the button re-labels itself from, so it
   * must not be conditional on how the mode finished.
   *
   * @returns a function that ends the mode.
   */
  start(handlers: PickHandlers, onEnd: () => void): () => void
}

/** Which picture is being pointed at — see {@link MapPicker.surface}. */
export type PickSurface = 'map' | 'track'

/** What one pick button calls itself, on each of the two surfaces. */
type PickLabels = Record<PickSurface, string>

export interface ManualCardProps {
  store: ManualStore
  picker: MapPicker
  /** The open file's short name, for what a saved file is called. */
  fileLabel: string
}

export class ManualCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  /**
   * What each pick button has to be told when the picture changes.
   *
   * A closure per button rather than the buttons themselves, because two things
   * move together and only one of them is a property: whether there is anything
   * to pick on, and *what* it is. See {@link pickButton}.
   */
  private readonly buttons: Array<(ready: boolean, surface: PickSurface) => void> = []
  private readonly exporter: ExportRow
  /** The line under the import zone saying what the last file gave. */
  private readonly importNote = el('p', { class: 'ann-note hidden' })
  private importZone!: HTMLElement
  /**
   * The eye over the list: every mark at once (§8.1), standing in the column
   * the rows' own eyes stand in, so which eyes it speaks for is read off the
   * card rather than off a label.
   */
  private readonly allEye = el('button', { class: 'btn btn-icon ann-eye manual-all-eye', type: 'button' })
  /** How many of them are hidden, beside the list's heading. */
  private readonly allNote = el('span', { class: 'manual-list-note' })
  /** Each row's eye by its mark's id, for a change of visibility to repaint in place. */
  private readonly eyes = new Map<string, HTMLButtonElement>()
  /** Each row's place, by mark, for a Tab to put the next mark's boxes over (§26.8). */
  private readonly wheres = new Map<string, HTMLElement>()
  /**
   * What the rows were last built from: each mark's id, colour and place.
   *
   * A change that leaves this alone — a mark hidden or shown — repaints the
   * eyes where they stand rather than building the list again. Rebuilt, the
   * button a reader had just pressed was gone from under the hand: a keyboard
   * lost its focus on every press, and the second click of a double-click
   * landed on a new button that had never had a first.
   */
  private builtFrom = ''

  constructor(private readonly props: ManualCardProps) {
    this.exporter = exportRow({
      // No resolution and no clipboard: this row writes a BED or a BEDPE, and
      // neither has dots per inch or a picture to paste (§26.6).
      formats: [
        { value: 'bed', label: 'lines (BED)' },
        // **The card's own words.** It read `loops & boxes (BEDPE)`, under
        // sub-heads saying Arrowheads and Rectangles: a reader who had drawn an
        // arrowhead looked for arrowheads and did not find them, and `loops`
        // names the loop *track* two cards up as well.
        { value: 'bedpe', label: 'arrowheads & rectangles (BEDPE)' },
      ],
      formatTitle: 'Which marks to write. The kinds are different objects, with one file each.',
      onFormat: () => this.paintSave(),
      onSave: (format) => void this.save(format as MarkFormat),
    })
    this.el = el(
      'section',
      { class: 'card annotation-card' },
      cardTitle('Manual annotations', 'pencil'),
      this.lineForm(),
      this.arrowForm(),
      this.rectForm(),
      this.list,
      this.importBlock(),
      this.exportBlock(),
    )
    this.cardDrops(this.el, this.importZone)
    this.allEye.addEventListener('click', () => this.props.store.toggleAll())
    this.unsubscribe = props.store.subscribe(() => this.render())
    this.render()
  }

  destroy(): void {
    this.unsubscribe()
  }

  /**
   * Enable, disable and re-word the pick buttons as views come and go.
   *
   * Both halves for the same reason: the picture under this card is replaced on
   * every navigation, and a button offering a gesture the mounted view cannot
   * complete — or naming a surface that is not on screen — is a button that
   * lies. The surface is asked for here rather than remembered, since a session
   * walks map → tracks → map without the card being rebuilt.
   */
  refresh(): void {
    const ready = this.props.picker.available()
    const surface = this.props.picker.surface?.() ?? 'map'
    for (const sync of this.buttons) sync(ready, surface)
  }

  // -------------------------------------------------------------------------
  // Adding
  // -------------------------------------------------------------------------

  private lineForm(): HTMLElement {
    const axis = el('select', { class: 'select' })
    for (const [value, label] of [
      ['vertical', 'vertical'],
      ['horizontal', 'horizontal'],
      ['both', 'both'],
    ] as const) {
      axis.appendChild(el('option', { value, text: label }))
    }

    const at = el('input', { class: 'input', type: 'text', placeholder: 'I:120,000' })
    // The drawn axis is a parameter with a default rather than a read of the
    // select, because one way in does not get to choose it: a pick on a track
    // is always a crosshair (see below), and the select is about the two ways in
    // that name an axis of a map.
    const add = (point: ManualPoint, drawn: LineAxis = axis.value as LineAxis): void => {
      this.props.store.add({
        id: mintMarkId(),
        kind: 'line',
        axis: drawn,
        at: point,
        colour: this.props.store.nextColour(),
      })
    }
    const typed = button('add', () => {
      const point = parsePoint(at.value)
      if (point === null) {
        at.classList.add('is-bad')
        return
      }
      at.classList.remove('is-bad')
      add(point)
      at.value = ''
    })
    at.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') typed.click()
    })

    // A vertical rule is a column, so it takes the column axis of the click; a
    // horizontal one takes the row. "Both" is one coordinate drawn twice, and
    // on the diagonal — where these are nearly always placed — the two axes
    // give the same answer anyway.
    //
    // Read from the select on every click rather than captured once: the mode
    // now outlives a single mark, so a reader may well place two verticals,
    // switch to horizontal and place a third without leaving it.
    //
    // **A line picked on a track is `both`**, whatever the select says, and it
    // is worth saying why a one-dimensional gesture writes a two-axis mark
    // rather than a new one-axis kind. A track has one axis, so a click on it
    // names a coordinate and not a direction — the row/column question the
    // select answers is a question about a picture that is not on screen. The
    // honest reading of "look at this coordinate" with no axis attached is the
    // crosshair: in the browser it draws as the single rule the reader asked
    // for, and when a map is opened afterwards the same mark is already the
    // vertical *and* the horizontal, with nothing to convert and no moment at
    // which the app has to guess what they meant. The select is left alone
    // rather than disabled, because it still governs everything typed into the
    // box above it.
    const pick = this.pickButton(
      { map: 'pick on map', track: 'pick on track' },
      {
        point: (at) =>
          at.oneAxis === true
            ? add(at.cols, 'both')
            : add(axis.value === 'horizontal' ? at.rows : at.cols),
      },
    )

    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Lines' }),
      el('div', { class: 'manual-row' }, axis, at),
      el('div', { class: 'manual-row' }, typed, pick),
    )
  }

  private arrowForm(): HTMLElement {
    const first = axisBox('rows', 'rows I:120,000')
    const second = axisBox('columns', 'columns I:340,000')
    const add = (a: ManualPoint, b: ManualPoint): void => {
      this.props.store.add({
        id: mintMarkId(),
        kind: 'arrowhead',
        a,
        b,
        colour: this.props.store.nextColour(),
      })
    }
    const typed = button('add', () => {
      const a = parsePoint(first.value)
      // One coordinate is a mark on the diagonal, which is the on-diagonal case
      // and is worth not making anyone type twice.
      const b = second.value.trim() === '' ? a : parsePoint(second.value)
      first.classList.toggle('is-bad', a === null)
      second.classList.toggle('is-bad', b === null)
      if (a === null || b === null) return
      add(a, b)
      first.value = ''
      second.value = ''
    })

    // One click is a cell, and a cell already has both coordinates — so an
    // arrowhead is one click, not two.
    //
    // On a **track** the two coordinates are the same one, so the click makes
    // the on-diagonal arrowhead — the domain corner this mark's own type is
    // documented for. That is the whole of what a single axis can honestly say
    // about a cell, and it is a mark worth having: the alternative, two
    // successive picks with a corner held in the reader's head between them, is
    // the gesture the rectangle form was rewritten to get rid of. A loop is
    // still one drag away on the map the tracks belong to.
    const pick = this.pickButton(
      { map: 'pick on map', track: 'pick on track' },
      { point: (at) => add(at.rows, at.cols) },
    )

    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Arrowheads' }),
      el('div', { class: 'manual-row' }, first, second),
      el('div', { class: 'manual-row' }, typed, pick),
    )
  }

  /**
   * Boxes: a stretch of rows by a stretch of columns.
   *
   * Two ranges rather than a range and a shape, so that on- and off-diagonal are
   * the same form and any ratio is expressible — a domain is `I:120000-180000`
   * against itself, a corner peak is two short stretches a megabase apart, and a
   * locus against a whole arm is a short one against a long one. Leaving the
   * second box empty means *the same stretch on both axes*, which is the box on
   * the diagonal and is not worth making anybody type twice; it is the same
   * courtesy the arrowhead form does for a cell on the diagonal.
   *
   * **Drawn with a drag**, which is the gesture a hand already makes for a box:
   * press at one corner, let go at the other, and the marquee the map draws
   * while the button is down is the mark that is about to exist. It used to be
   * two clicks, and two clicks made the reader hold a corner in their head
   * between them — the card had to say which one it was holding, because the
   * picture could not.
   *
   * Holding **Shift** while drawing locks the box to the diagonal, so a domain
   * is one gesture. On a turned map every drag is that, the band being the only
   * thing there with coordinates on it.
   */
  private rectForm(): HTMLElement {
    const first = axisBox('rows', 'rows I:120,000-180,000')
    const second = axisBox('columns', 'columns I:340,000-400,000')
    const add = (a: ManualSpan, b: ManualSpan): void => {
      this.props.store.add({
        id: mintMarkId(),
        kind: 'rect',
        a,
        b,
        colour: this.props.store.nextColour(),
      })
    }
    const typed = button('add', () => {
      const a = parseSpan(first.value)
      const b = second.value.trim() === '' ? a : parseSpan(second.value)
      first.classList.toggle('is-bad', a === null)
      second.classList.toggle('is-bad', b === null)
      if (a === null || b === null) return
      add(a, b)
      first.value = ''
      second.value = ''
    })
    for (const box of [first, second]) {
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') typed.click()
      })
    }

    // On a **track** the drag has one axis, so the browser reports the same
    // stretch as the rows and as the columns and this makes the square on the
    // diagonal — which is what a band drawn across a genome browser means: *this
    // block of contacts*, from here to here, against itself. No schema change
    // and no 1D-only kind: the mark a reader draws in the browser is already the
    // mark the map will show them.
    const pick = this.pickButton(
      { map: 'draw on map', track: 'draw on track' },
      { box: (at) => add(at.rows, at.cols) },
    )

    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Rectangles' }),
      el('div', { class: 'manual-row' }, first, second),
      el('div', { class: 'manual-row' }, typed, pick),
    )
  }

  /**
   * A button that turns picking on, and then turns it off.
   *
   * One button with two labels rather than two controls: while the mode is on,
   * the only thing the reader can want from this button is to stop, so that is
   * what it offers. `done` and Escape are the same act by two roads, which is
   * why both run {@link end}.
   *
   * The mode is *not* ended by placing a mark. Marking up a figure means placing
   * several — four domains boxed, every loop worth an arrowhead — and the round
   * trip to the sidebar between each one was the whole cost of doing it here
   * rather than by typing coordinates.
   *
   * What the mode listens for is whatever the form handed over: a click for the
   * two marks that name a place, a drag for the one that names an extent. The
   * button says which in its own hint, since a reader who clicks at a map that
   * is waiting for a drag has been given no way to find that out.
   *
   * **One button per form, whichever picture is mounted.** The label and the
   * hint are a pair of sentences and not one, because the same gesture means
   * something slightly different on a contact map and on a track — the second is
   * one axis, so what it places lands on the diagonal — and a reader deserves to
   * be told that before they press it rather than afterwards from the list. A
   * second, browser-only button would have been the other way to say it, and it
   * would have doubled the machinery below: the arming, the `Done` state, the
   * Escape road and the "another form armed over this one" rule are the parts
   * that are hard to get right, and there is exactly one of them here.
   */
  private pickButton(labels: PickLabels, handlers: PickHandlers): HTMLButtonElement {
    const hints: PickLabels =
      handlers.box === undefined
        ? {
            map: 'Then click the plot, as often as you like. Escape or done stops.',
            track:
              'Then click the tracks, as often as you like. A track has one axis, so the ' +
              'mark lands on the diagonal. Escape or done stops.',
          }
        : {
            map:
              'Then drag a box on the plot, as many as you like — Shift keeps it on the ' +
              'diagonal. Escape or done stops.',
            track:
              'Then drag across the tracks, as many as you like. A track has one axis, so ' +
              'the box is the square on the diagonal. Escape or done stops.',
          }
    let stop: (() => void) | null = null

    /**
     * What this button says, given what is on screen — and nothing while armed.
     *
     * The armed button is a `done` button: it has stopped naming the gesture and
     * started offering the way out of it, so a navigation underneath must not
     * rename it back. Its own `rest` is what puts it into this pass again.
     */
    const sync = (ready: boolean, surface: PickSurface): void => {
      node.disabled = !ready
      if (stop !== null) return
      node.textContent = labels[surface]
      node.title = hints[surface]
    }

    const rest = (): void => {
      stop = null
      node.classList.remove('is-armed')
      // Every pick button on the card comes back at once: only one mode can be
      // on, so arming the other one has just ended this. The label comes back
      // through the same pass, so it names whatever is on screen *now* rather
      // than whatever was there when the mode was armed.
      this.refresh()
    }

    const node = button(
      labels.map,
      () => {
        if (stop !== null) {
          stop()
          return
        }
        node.classList.add('is-armed')
        node.textContent = 'done'
        node.title = 'Stop placing marks. Escape does the same.'
        // Set before `start`, so a picker that ends the mode synchronously —
        // because there is no plot — still finds something to clear.
        stop = () => {}
        const end = this.props.picker.start(handlers, rest)
        if (stop !== null) stop = end
      },
      { class: 'btn', title: hints.map },
    )
    this.buttons.push(sync)
    sync(this.props.picker.available(), this.props.picker.surface?.() ?? 'map')
    return node
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  /**
   * Saving the marks: which kind, and the mark that writes them.
   *
   * `ui/exportRow.ts`, the one export row in the app, with the resolution and
   * the clipboard left out — a BED is not a picture, so it has no dpi to choose
   * and nothing to paste. It was this row's own select beside a bordered,
   * capitalised `Save`: one control named like a dialog's primary button in a
   * column of lowercase verbs, and a fourth idiom for an act three other cards
   * already draw one way.
   *
   * The dropdown chooses *which marks*, not just which container, because the
   * kinds are different objects and there is one standard file for each: a line
   * is a point on the genome, and an arrowhead and a rectangle are each a pair
   * of places. Saying so in the option label is more honest than a single
   * "export" that quietly writes half of what is on screen.
   *
   * Under an `Export` sub-head, like the three forms above it and the Bookmarks
   * card's `Import` below it: export and import are mirror acts, and drawing one
   * as a section and the other as a field label made two neighbours disagree
   * about what kind of thing each was.
   */
  private exportBlock(): HTMLElement {
    return el(
      'div',
      { class: 'manual-form manual-export' },
      el('span', { class: 'manual-form-title', text: 'Export' }),
      this.exporter.body,
    )
  }

  /**
   * Marks, in: the Export row's mirror, and the file it writes.
   *
   * A zone to drop on that is also a button to click, the Tracks card's
   * `.ann-drop`, because both are how a file reaches a card in this app. It
   * takes either file the export row writes — and any other BED or BEDPE, read
   * the way `annotations/export.ts`'s {@link readMarks} says — so a figure's
   * marks travel to a colleague's copy of the same map and come back as marks
   * they can recolour and remove, rather than as a track they cannot.
   *
   * The whole card takes the drop, and the zone lights up as soon as a file
   * crosses it, on the Tracks card's rule. The drop stops here: the same BED let
   * go over the map is a *lane*, and this card is where a reader aims when they
   * mean marks.
   */
  private importBlock(): HTMLElement {
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.accept = '.bed,.bedpe,.txt,.tsv'
    input.multiple = true
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])]
      // Cleared so choosing the same file twice fires `change` the second time.
      input.value = ''
      void this.readFiles(files)
    })
    const zone = el(
      'div',
      { class: 'ann-drop', attrs: { tabindex: '0', role: 'button' } },
      // Worded like the Tracks card's zone, which is the same gesture: what it
      // loads, what it takes, and the two ways in.
      el('span', { class: 'ann-drop-label', text: 'Load marks' }),
      el('span', {
        class: 'ann-drop-hint',
        text: 'BED or BEDPE. Drop here, or click to choose.',
      }),
    )
    zone.title = 'BED → lines, BEDPE → arrowheads & rectangles. Duplicates are skipped.'
    zone.addEventListener('click', () => input.click())
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        input.click()
      }
    })
    this.importZone = zone
    return el(
      'div',
      { class: 'manual-form manual-import' },
      el('span', { class: 'manual-form-title', text: 'Import' }),
      zone,
      input,
      this.importNote,
    )
  }

  /** The Tracks card's `cardDrops`: the card takes the file, the zone says so. */
  private cardDrops(host: HTMLElement, zone: HTMLElement): void {
    host.addEventListener('dragover', (event) => {
      if (!dragHasFiles(event)) return
      event.preventDefault()
      zone.classList.add('over')
    })
    host.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return
      zone.classList.remove('over')
    })
    host.addEventListener('drop', (event) => {
      const files = filesFrom(event.dataTransfer)
      zone.classList.remove('over')
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      void this.readFiles(files)
    })
  }

  private async readFiles(files: readonly File[]): Promise<void> {
    const said: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = await file.text()
      } catch {
        said.push(`${file.name}: unreadable.`)
        continue
      }
      const { marks, skipped } = readMarks(text)
      if (marks.length === 0) {
        said.push(`${file.name}: no marks.`)
        continue
      }
      const added = this.props.store.addAll(marks)
      const parts = [`${fmt.int(added)} added`]
      if (added < marks.length) parts.push(`${fmt.int(marks.length - added)} already there`)
      if (skipped > 0) parts.push(`${fmt.int(skipped)} skipped`)
      said.push(`${file.name}: ${parts.join(', ')}.`)
    }
    // A line a file: two dropped at once are two answers, and run together
    // they read as one sentence about neither.
    this.importNote.replaceChildren(...said.map((text) => el('div', { text })))
    this.importNote.classList.toggle('hidden', said.length === 0)
  }

  /** Nothing of this kind to write is a disabled button, not an empty file. */
  private paintSave(): void {
    const format = this.exporter.format() as MarkFormat
    const marks = marksFor(this.props.store.marks, format)
    const count = marks.length
    // Every mark is written, the hidden ones too: hiding is about what is
    // drawn, and a file of marks is the marks — the tooltip says how many of
    // them the pictures are not showing, so the count is not a surprise.
    const hidden = marks.filter((mark) => !isShown(mark)).length
    const save = this.exporter.parts.save
    save.disabled = count === 0
    save.title =
      count === 0
        ? `No ${format === 'bed' ? 'lines' : 'arrowheads or rectangles'} have been drawn yet`
        : `Write ${fmt.int(count)} to a file this app — and bedtools — reads back` +
          (hidden === 0 ? '' : `, the ${fmt.int(hidden)} hidden among them`)
  }

  private async save(format: MarkFormat): Promise<void> {
    const now = new Date()
    const text = formatMarks(this.props.store.marks, format, {
      file: this.props.fileLabel,
      created: fileStamp(now),
    })
    const name = `${exportBaseName(this.props.fileLabel)}-marks-${fileStamp(now)}.${format}`
    const saved = await downloadBlob(new Blob([text], { type: 'text/plain' }), name)
    if (saved === null) return
    // The line under the row, where the Export card says what just happened: a
    // download that goes straight to a folder leaves nothing on screen saying
    // it did, and *which* marks went is the question this row's select asks —
    // under the name the reader gave it, where the save dialog let them.
    this.exporter.note.textContent = `${fmt.int(marksFor(this.props.store.marks, format).length)} · ${saved}`
  }

  private render(): void {
    this.paintSave()
    const marks = this.props.store.marks
    if (marks.length === 0) {
      this.builtFrom = ''
      this.eyes.clear()
      this.wheres.clear()
      this.list.replaceChildren()
      return
    }
    const shape = marks.map((mark) => `${mark.id}\t${mark.colour}\t${describeMark(mark)}`).join('\n')
    if (shape !== this.builtFrom) {
      this.builtFrom = shape
      this.eyes.clear()
      this.wheres.clear()
      this.list.replaceChildren(
        this.listHead(),
        ...marks.map((mark) => this.row(mark)),
        button('remove all', () => this.props.store.clear(), {
          class: 'btn btn-quiet btn-wide',
          title: 'Clear every hand-drawn mark on this file',
        }),
      )
    }
    this.paintVisibility(marks)
  }

  /**
   * The list's heading: its name, how many are hidden, and the eye for all of
   * them — over the column of the rows' eyes, with the room a row's × takes
   * kept empty after it, so the one eye stands at the head of the others.
   *
   * The eye is lit while **any** mark is drawn, as the Groups card's is for a
   * group, and a press then hides them all; with none drawn it brings back the
   * ones it hid — and only those, so a mark put away from its own row for a
   * figure stays away (`ManualStore.toggleAll`). `A` is the same press.
   */
  private listHead(): HTMLElement {
    // The ×'s twin, unseen: the same button at the same size, so the room it
    // keeps is the room a row's × takes whatever the theme or the text scale.
    const room = iconButton('x', '', () => {}, { class: 'btn-close manual-list-room', size: 14 })
    room.tabIndex = -1
    room.setAttribute('aria-hidden', 'true')
    return el(
      'div',
      { class: 'ann-row manual-list-head' },
      el(
        'div',
        { class: 'ann-head' },
        el('span', { class: 'manual-form-title', text: 'Marks' }),
        this.allNote,
        this.allEye,
        room,
      ),
    )
  }

  /** Every eye on the card, from the store as it stands: the rows' and the one over them. */
  private paintVisibility(marks: readonly ManualMark[]): void {
    for (const mark of marks) {
      const eye = this.eyes.get(mark.id)
      if (eye === undefined) continue
      const shown = isShown(mark)
      paintEye(
        eye,
        shown,
        shown
          ? 'Hide this mark on every map, track and model — double-click to show it alone'
          : mark.hidden === 'all'
            ? 'Hidden with the rest: show this one again — double-click to show it alone'
            : 'Show this mark again — double-click to show it alone',
      )
    }
    const hidden = this.props.store.hiddenCount
    const anyShown = hidden < marks.length
    paintEye(
      this.allEye,
      anyShown,
      withKey(
        anyShown
          ? 'Hide every mark, on every map, track and model'
          : marks.some((mark) => mark.hidden === 'all')
            ? 'Show the marks again — the ones hidden together'
            : 'Show every mark again',
        KEYS.marks,
      ),
    )
    this.allNote.textContent =
      hidden === 0 ? '' : anyShown ? `${fmt.int(hidden)} of ${fmt.int(marks.length)} hidden` : `all ${fmt.int(marks.length)} hidden`
  }

  /**
   * A row's eye (§8.1): the mark off every map, track and model, and back.
   *
   * A click reads the mark as it is *now*, not as the row was built with it —
   * the row outlives a change of visibility. A double-click shows the mark
   * alone, and alone already, brings the others back: its two clicks have
   * hidden it and shown it again by then, so the store is asked from where the
   * reader started.
   */
  private eye(mark: ManualMark): HTMLButtonElement {
    const node = el('button', { class: 'btn btn-icon ann-eye', type: 'button' })
    node.addEventListener('click', () => {
      const held = this.props.store.marks.find((each) => each.id === mark.id)
      if (held !== undefined) this.props.store.setShown(mark.id, !isShown(held))
    })
    node.addEventListener('dblclick', () => this.props.store.showAlone(mark.id))
    this.eyes.set(mark.id, node)
    return node
  }

  private row(mark: ManualMark): HTMLElement {
    const colour = el('input', { class: 'ann-colour', type: 'color', value: mark.colour })
    colour.addEventListener('input', () => this.props.store.update(mark.id, { colour: colour.value }))

    // A colour, where it is, and a way to remove it. A mark says *look here*;
    // what to look at is the map, and a caption box under every one of them was
    // a text field to fill in for a sentence the figure already makes.
    //
    // **Where it is, pressed, is where it is typed.** A mark put down a bin off
    // used to be removed and drawn again, which lost its colour and moved it
    // to the end of the list; the row's text is the mark's own form now, in the
    // boxes the forms above use, for the mark to be moved in place.
    const head = el('div', { class: 'ann-head' })
    const where = el('button', {
      class: 'manual-where',
      type: 'button',
      text: describeMark(mark),
      title: `${describeMark(mark)} — click to edit`,
    })
    where.addEventListener('click', () => this.editRow(where, mark))
    this.wheres.set(mark.id, where)
    head.append(
      colour,
      where,
      // Where the Tracks card's rows carry theirs, before the ×: the same
      // control with the same meaning, a column apart.
      this.eye(mark),
      iconButton('x', 'Remove this mark', () => this.props.store.remove(mark.id), {
        class: 'btn-close',
        size: 14,
      }),
    )
    return el('div', { class: 'ann-row manual-mark' }, head)
  }

  /**
   * The row's coordinates as boxes, over the text they replace: Enter or a
   * click elsewhere moves the mark, Escape leaves it where it was.
   *
   * The boxes the adding forms use, taking what they take — grouped digits,
   * `kb`, an en dash — and one box for the second axis left empty means the
   * same place on both, as it does there. A line keeps its axis select, since
   * which rule is drawn is part of where it is.
   */
  private editRow(where: HTMLElement, mark: ManualMark, from: 'first' | 'last' = 'first'): void {
    const boxes: HTMLInputElement[] = []
    let axis: HTMLSelectElement | null = null
    if (mark.kind === 'line') {
      axis = el('select', { class: 'select select-tiny manual-edit-axis', title: 'Which rule' })
      for (const value of ['vertical', 'horizontal', 'both'] as const) {
        axis.appendChild(el('option', { value, text: value }))
      }
      axis.value = mark.axis
      boxes.push(el('input', { class: 'input manual-edit-box', type: 'text', value: pointLabel(mark.at), attrs: { 'aria-label': 'where' } }))
    } else if (mark.kind === 'arrowhead') {
      boxes.push(el('input', { class: 'input manual-edit-box', type: 'text', value: pointLabel(mark.a), attrs: { 'aria-label': 'rows' }, title: 'rows' }))
      boxes.push(el('input', { class: 'input manual-edit-box', type: 'text', value: pointLabel(mark.b), attrs: { 'aria-label': 'columns' }, title: 'columns' }))
    } else {
      boxes.push(el('input', { class: 'input manual-edit-box', type: 'text', value: spanLabel(mark.a), attrs: { 'aria-label': 'rows' }, title: 'rows' }))
      boxes.push(el('input', { class: 'input manual-edit-box', type: 'text', value: spanLabel(mark.b), attrs: { 'aria-label': 'columns' }, title: 'columns' }))
    }
    const editor = el('div', { class: 'manual-edit', attrs: { [TAB_WALKS]: '' } }, ...(axis === null ? [] : [axis]), ...boxes)
    where.replaceWith(editor)
    // The last box where a Shift+Tab came back into this mark from the next.
    const opened = from === 'last' ? boxes[boxes.length - 1] : boxes[0]
    opened?.focus()
    opened?.select()

    let done = false
    const close = (): void => {
      done = true
      editor.replaceWith(where)
    }
    const commit = (): void => {
      if (done) return
      const next = this.typedMark(mark, boxes, axis)
      boxes.forEach((box, i) => box.classList.toggle('is-bad', next === null && this.badBox(mark, boxes, i)))
      if (next === null) return
      done = true
      // The store's change repaints the list, and a mark that moved takes the
      // row this editor stands in with it. One entered back where it was is
      // repainted in place (see {@link builtFrom}), so the row is put back
      // here — its text is the same text.
      this.props.store.reshape(next)
      if (editor.isConnected) editor.replaceWith(where)
    }
    editor.addEventListener('keydown', (event) => {
      const step = tabStep(event)
      if (step !== null) {
        // Between this mark's own boxes Tab is the page's; off the last of them
        // — Shift+Tab off the first — it is Enter that goes on to the next mark
        // in the list, or the one before, and past either end nowhere (§26.8).
        const stops: HTMLElement[] = [...(axis === null ? [] : [axis]), ...boxes]
        const at = stops.indexOf(document.activeElement as HTMLElement)
        if (at >= 0 && stops[at + step] !== undefined) return
        event.preventDefault()
        commit()
        if (!done) return
        const marks = this.props.store.marks
        const next = marks[marks.findIndex((each) => each.id === mark.id) + step]
        // Looked up after the commit, which repaints the list a moved mark is in.
        const nextWhere = next === undefined ? undefined : this.wheres.get(next.id)
        if (next !== undefined && nextWhere !== undefined) this.editRow(nextWhere, next, step === 1 ? 'first' : 'last')
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    })
    // A click anywhere outside the boxes is the reader finished with them.
    editor.addEventListener('focusout', (event) => {
      if (event.relatedTarget instanceof Node && editor.contains(event.relatedTarget)) return
      if (!done) commit()
      if (!done) close()
    })
  }

  /** The mark the boxes describe, or `null` where one of them does not read. */
  private typedMark(mark: ManualMark, boxes: HTMLInputElement[], axis: HTMLSelectElement | null): ManualMark | null {
    const [first, second] = boxes.map((box) => box.value.trim())
    if (mark.kind === 'line') {
      const at = parsePoint(first ?? '')
      return at === null ? null : { ...mark, at, axis: (axis?.value ?? mark.axis) as LineAxis }
    }
    if (mark.kind === 'arrowhead') {
      const a = parsePoint(first ?? '')
      const b = (second ?? '') === '' ? a : parsePoint(second ?? '')
      return a === null || b === null ? null : { ...mark, a, b }
    }
    const a = parseSpan(first ?? '')
    const b = (second ?? '') === '' ? a : parseSpan(second ?? '')
    return a === null || b === null ? null : { ...mark, a, b }
  }

  /** Whether box `i` is one that does not read, for its red edge. */
  private badBox(mark: ManualMark, boxes: HTMLInputElement[], i: number): boolean {
    const text = boxes[i]?.value.trim() ?? ''
    if (i === 1 && text === '') return false
    return mark.kind === 'rect' ? parseSpan(text) === null : parsePoint(text) === null
  }
}

/**
 * One of the two boxes that name an axis, with the axis word in front.
 *
 * It used to be behind, in brackets — `I:340000 (columns)` — and in a 288-pixel
 * column split in two the brackets were the part that got cut: the second box
 * read `I:340000 (columns`, or in the rectangle form `I:340000-400000 (`, so the
 * one thing telling a reader which box was rows and which was columns was the
 * one thing they could not see. In front it survives the width, and the
 * `aria-label` says it again for a reader who is not looking at the box at all.
 */
function axisBox(axis: 'rows' | 'columns', placeholder: string): HTMLInputElement {
  const box = el('input', {
    class: 'input',
    type: 'text',
    placeholder,
    title: axis,
    attrs: { 'aria-label': axis },
  })
  // **As wide as the example it offers, or on a line of its own.** The two boxes
  // share a row that shrinks them to nothing rather than wrapping: in a 288-pixel
  // column the rectangle form's pair had 115 pixels each and read
  // `rows I:120,000-18` and `columns I:340,00` — a half-locus, which is worse
  // than a cut word because `I:120,000-18` is itself a valid thing to type.
  //
  // `ch` is the advance of one digit in the face the box is set in, so the basis
  // *is* the placeholder's width; `.manual-row` wraps, so a pair that cannot sit
  // side by side takes a line each instead of splitting the difference. The
  // arrowhead form's shorter pair still fits across.
  box.style.flexBasis = `calc(${placeholder.length}ch + 1.2rem)`
  return box
}

/**
 * Draw an eye as a toggle is drawn (§26.3): open and lit while what it speaks
 * for is shown, shut and plain while it is not, named for what a press does.
 * The glyph is swapped only when the state is, so a repaint under a hovering
 * pointer does not flicker it.
 */
function paintEye(node: HTMLButtonElement, shown: boolean, title: string): void {
  if (node.dataset['shown'] !== String(shown)) {
    node.dataset['shown'] = String(shown)
    node.replaceChildren(icon(shown ? 'eye' : 'eye-off', { size: 14 }))
  }
  node.title = title
  node.setAttribute('aria-label', title)
  setPressed(node, shown)
}

/** Re-exported so a caller needs one import to seed a colour. */
export { MANUAL_PALETTE }
