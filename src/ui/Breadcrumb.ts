/**
 * The breadcrumb: `genomes → genome → contig → region` (spec §5.5).
 *
 * Every segment is clickable to go back up, which is the only navigation
 * affordance the app needs given that the view state is one flat object.
 *
 * Two segments are pickers rather than links, because they select *what is
 * open* rather than move within it:
 *
 * - **the entry picker**, shown only for an mmetacool, which chooses which
 *   nested metacool the rest of the trail describes (§3.4). It precedes the
 *   root because switching entry invalidates every crumb after it.
 * - **the root picker**, which chooses between the genomes and the contigs
 *   table. Both are landing views over the same file, so a link between them
 *   would be a crumb that goes sideways; a select says "pick a table".
 *
 * For a plain cooler the root picker collapses to plain text: the synthesised
 * single-genome table has nothing to show (§9), so `contigs` is the only choice.
 */

import { KEYS, keyBadge, withKey } from './commands'
import { icon } from './icons'
import { cellsOf, selectionOf } from '../state/ViewState'
import type { ViewState } from '../types'
import { el } from './dom'

/**
 * The four things the root crumb can be.
 *
 * All four are {@link ViewState} views, which is what lets this picker be one
 * thing: every entry navigates, and the crumb reads the answer back off the
 * state. `overview` was the exception — a mode the shell held beside the state —
 * and every place that knew it was routed around the trail rather than through
 * it.
 */
export type RootChoice = 'genomes' | 'cells' | 'contigs' | 'overview' | 'whole'

/**
 * Title Case, because these are the names of views, not field values.
 *
 * `contigs` is *Chromosomes* on a cooler. The word is not cosmetic: a cooler
 * holds one genome's chromosomes, and calling them contigs asks the reader to
 * translate on every screen. `overview` and `whole` share a label because they
 * answer the same question — the whole file at once — by different means: a
 * pixel scan for a metagenome, one bounded read for a genome small enough.
 */
const ROOT_LABEL: Record<RootChoice, string> = {
  genomes: 'Genomes',
  cells: 'Cells',
  contigs: 'Contigs',
  overview: 'Whole genome',
  whole: 'Whole genome',
}

/**
 * The key that reaches each landing view, for the tooltips on this crumb.
 *
 * The same three keys the command list binds, read from the same place: a
 * reader who finds "Whole genome" here and presses W in the table next time is
 * doing what this tooltip told them to.
 */
const ROOT_KEYS: Record<RootChoice, string> = {
  genomes: KEYS.genomes,
  // The same key as Genomes, and deliberately — see `KEYS.genomes`.
  cells: KEYS.genomes,
  contigs: KEYS.contigs,
  overview: KEYS.whole,
  whole: KEYS.whole,
}

export interface BreadcrumbProps {
  /** Root of the hierarchy: the landing view for this kind of file. */
  rootKind: 'genomes' | 'cells' | 'contigs'
  /** Landing views this file can offer. One entry hides the picker. */
  rootChoices: RootChoice[]
  /**
   * Choices to show but not offer, with the reason.
   *
   * A cooler has no genomes, and *hiding* the entry would leave the reader
   * wondering whether this viewer has a genomes table at all. Greyed out with
   * a reason answers the question instead of raising it.
   */
  disabledChoices?: Partial<Record<RootChoice, string>>
  /** What a contig is called in this file: `Contigs`, or `Chromosomes`. */
  contigNoun?: string
  /** Short label for the open file, shown as the first crumb. */
  fileLabel: string
  /** Entry names of the enclosing mmetacool, or `[]` for a plain metacool. */
  entries: string[]
  /** The entry currently open, when {@link entries} is non-empty. */
  currentEntry?: string
  /** What one entry is called in this format: an entry, or a resolution. */
  entryNoun?: string
  /**
   * Cells in the open `.scool`, for the crumb that says which are being summed;
   * `0` for every other container.
   */
  cellCount?: number
  onNavigate(state: ViewState): void
  /**
   * The file crumb was clicked. It opens a file *over* the current view rather
   * than navigating away to ask, so that changing your mind costs nothing —
   * a dropped local file cannot be re-opened without another gesture (§11), so
   * leaving the view to look at the picker used to be one-way.
   */
  onOpenFile(): void
  /** An mmetacool entry was picked; the caller re-opens the file at it. */
  onSelectEntry?(entry: string): void
}

/**
 * Which table a view was reached through — the crumb that leads back to it.
 *
 * A table view names itself. Below that the trail used to fall back to the
 * file's *default* root, so opening a contig from the Contigs table produced
 * "Genomes > NODE_18007", a path that does not exist and that leads back to a
 * table the reader was never in.
 *
 * The signal is already in the state and needs no remembering: a contig opened
 * from within a genome carries that genome (`region` beside `genome`), and one
 * opened from the contigs table does not. Reading it off the state rather than
 * off a mode means a shared link rebuilds the same trail as the session that
 * produced it.
 */
export function rootTable(
  state: ViewState,
  fallback: 'genomes' | 'cells' | 'contigs',
): 'genomes' | 'cells' | 'contigs' {
  if (state.view === 'genomes' || state.view === 'contigs' || state.view === 'cells') {
    return state.view
  }
  if (state.view === 'region') return state.genome === undefined ? 'contigs' : 'genomes'
  // A selection leads back to the table it was ticked in, which is the one that
  // can un-tick it. A `selection` naming nothing is not one, and falls through
  // to the file's default like the other whole-file views — the shell redirects
  // it to one of them anyway.
  const kind = state.view === 'selection' ? selectionOf(state)?.kind : undefined
  if (kind !== undefined) return kind === 'genome' ? 'genomes' : 'contigs'
  // A genome or a pair is by definition below the genomes table; `whole` and
  // `overview` are neither, and keep the file's own default.
  return state.genome === undefined ? fallback : 'genomes'
}

/**
 * `1 kb`, `50 kb`, `1 Mb` — a bin size, written the way a reader says it.
 *
 * Not `fmt.bp`, and the difference is the decimal: that formatter is for
 * measured lengths and always carries one, so a 1 kb rung came out `1.0 kb` and
 * a 1 Mb one `1.00 Mb`. A resolution is a round number by construction — it is
 * what `cooler zoomify` was given — so the places are trimmed and only the ones
 * that say something survive: `12.5 kb` keeps its half, `1 kb` does not gain a
 * zero. Falls back to base pairs below a kilobase, which is where a Micro-C
 * ladder starts.
 */
export function resolutionLabel(bp: number): string {
  if (!Number.isFinite(bp) || bp <= 0) return '—'
  if (bp >= 1e6) return `${trim(bp / 1e6)} Mb`
  if (bp >= 1e3) return `${trim(bp / 1e3)} kb`
  return `${trim(bp)} bp`
}

/** Two places at most, and none where they would all be zeros. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * Where the resolution radios' `name` comes from.
 *
 * One group per rendered bar rather than one per application: `render` replaces
 * the whole row, and two bars alive at once — a deck's panels, a tab being torn
 * down behind the one in front — sharing a group name would let a radio in the
 * old one unset the checked radio in the new.
 */
const GROUP_PREFIX = 'metacooler-resolution-'
let groups = 0

/**
 * How many rungs are drawn as a row of clickable stops.
 *
 * Six fits across the right-hand end of a crumb row without pushing the place
 * the reader is looking at off the left of a laptop screen. Past it the slider
 * carries the walk on its own — see {@link Breadcrumb.pushResolution}.
 */
const MAX_STOPS = 6

export class Breadcrumb {
  readonly el: HTMLElement

  constructor(private readonly props: BreadcrumbProps) {
    this.el = el('nav', { class: 'breadcrumb', attrs: { 'aria-label': 'breadcrumb' } })
  }

  /** Re-render for a state. Safe to call on every state change. */
  render(state: ViewState | null): void {
    this.el.replaceChildren()
    if (state === null) {
      this.el.appendChild(el('span', { class: 'crumb current', text: 'open a file' }))
      return
    }
    this.trail(state)
    // **Last, after the place.** The resolution is not a step of the trail: it
    // does not contain the crumbs before it and clicking it does not go
    // anywhere — it is how finely the same place is drawn. It spent a release as
    // the second crumb, between the file name and the table, which read as *this
    // file, then this resolution, then these chromosomes* and put a control the
    // reader changes often at the one end of the bar they scroll past on the way
    // to the coordinates.
    this.pushResolution()
  }

  /** The trail proper: file → table → genome → contig → region. */
  private trail(state: ViewState): void {
    this.push(this.props.fileLabel, () => this.props.onOpenFile(), false, 'file')
    this.pushEntryPicker()
    this.pushRootPicker(state)
    this.pushCells(state)

    // A selection hangs off the table it was made in: several genomes are below
    // the genomes table, several contigs below the contigs one. Named while
    // there are few enough to read, counted after that — the same rule the
    // view's own heading follows, so the crumb and the heading agree.
    const selection = selectionOf(state)
    if (state.view === 'selection' && selection !== null) {
      const noun = selection.kind === 'genome' ? 'genomes' : (this.props.contigNoun ?? 'contigs')
      this.push(
        selection.names.length <= 3
          ? selection.names.join(' × ')
          : `${selection.names.length} ${noun.toLowerCase()}`,
        undefined,
        true,
      )
      return
    }

    if (state.view === 'pair' && state.genome !== undefined && state.genome2 !== undefined) {
      this.push(state.genome, () =>
        this.props.onNavigate({ uri: state.uri, view: 'genome', genome: state.genome }),
      )
      this.push(`${state.genome} × ${state.genome2}`, undefined, true)
      return
    }

    if (state.genome !== undefined) {
      const genomeState: ViewState = { uri: state.uri, view: 'genome', genome: state.genome }
      this.push(state.genome, () => this.props.onNavigate(genomeState), state.view === 'genome')
    }

    if (state.view === 'region' && state.region !== undefined) {
      const contig = state.region.split(':')[0]
      const hasCoordinates = state.region.includes(':')
      const contigState: ViewState = { uri: state.uri, view: 'region', region: contig, genome: state.genome }
      this.push(contig, hasCoordinates ? () => this.props.onNavigate(contigState) : undefined, !hasCoordinates)
      if (state.region2 !== undefined) {
        this.push(`${contig} × ${state.region2.split(':')[0]}`, undefined, true)
      } else if (hasCoordinates) {
        this.push(state.region, undefined, true)
      }
    }
  }

  /**
   * Which cells the map below is summed from — an scool's second crumb (§3.8).
   *
   * It has to be *somewhere*, and this is the one place that is on screen in
   * every view: a cell set is not the subject of the view the way a genome is,
   * it is the subject of the **file**, and a reader three clicks into a locus
   * has otherwise nothing telling them whether they are looking at one cell or
   * four thousand. Which is the difference between a scatter of dots and a
   * contact map, so it must not be inferrable only from the picture.
   *
   * One cell is named; a handful are counted; everything is called *all*,
   * because that is the state the file opens in and a reader needs to be able
   * to tell it from a selection that happens to be large. Clicking returns to
   * the table where the ticks are, which is the only place the set changes.
   */
  private pushCells(state: ViewState): void {
    const total = this.props.cellCount ?? 0
    if (total === 0 || state.view === 'cells') return
    const names = cellsOf(state)
    const label =
      names === null
        ? `all ${total.toLocaleString()} cells`
        : names.length === 1
          ? (names[0] ?? '')
          : `${names.length.toLocaleString()} cells`
    this.separator()
    const crumb = el('button', {
      class: 'crumb',
      type: 'button',
      text: label,
      title:
        names === null
          ? `Every cell in this file, added together. Back to the cells table to choose fewer.`
          : names.length === 1
            ? `One cell: ${names[0]}. Back to the cells table to choose others.`
            : `${names.length.toLocaleString()} cells, added together: ${names.slice(0, 6).join(', ')}` +
              `${names.length > 6 ? ', …' : ''}. Back to the cells table to change them.`,
    })
    crumb.addEventListener('click', () =>
      this.props.onNavigate({ uri: state.uri, view: 'cells', cells: state.cells }),
    )
    this.el.appendChild(crumb)
  }

  /**
   * The mmetacool entry picker, before the root (§3.4).
   *
   * **Entries only, never resolutions.** A nested metacool is a different *file*
   * — switching it invalidates every crumb after it, which is why it precedes the
   * root — so it is a step of the trail and belongs in the trail. A rung of a
   * `zoomify` ladder is the same file drawn more or less finely, so it is not,
   * and it has its own control at the far end ({@link pushResolution}).
   */
  private pushEntryPicker(): void {
    const { entries, currentEntry, onSelectEntry } = this.props
    if (entries.length === 0 || onSelectEntry === undefined) return
    if (this.ladder() !== null) return
    const select = el('select', { class: 'crumb-select', title: 'Nested metacool to view' })
    for (const name of entries) {
      select.appendChild(el('option', { value: name, text: name }))
    }
    if (currentEntry !== undefined) select.value = currentEntry
    select.addEventListener('change', () => onSelectEntry(select.value))
    this.separator()
    this.el.appendChild(select)
  }

  /**
   * The rungs of this file, finest first — or `null` when it has no ladder.
   *
   * §3.4's rule, and the same one `ui/refine.ts` applies to decide whether a
   * collection is a ladder or a set of samples: every entry name parses as a
   * positive integer. A collection of replicates called `1`, `2`, `3` would pass
   * it, and it is the rule the whole application already reads that file by, so
   * this agreeing with it is the point.
   */
  private ladder(): Array<{ name: string; binsize: number }> | null {
    const { entries, onSelectEntry } = this.props
    if (entries.length === 0 || onSelectEntry === undefined) return null
    if (this.props.entryNoun !== 'resolution') return null
    if (!entries.every((name) => /^\d+$/.test(name) && Number(name) > 0)) return null
    return entries
      .map((name) => ({ name, binsize: Number(name) }))
      .sort((a, b) => a.binsize - b.binsize)
  }

  /**
   * The resolution, at the far end of the bar: a slider over a row of stops.
   *
   * It was a `<select>` of raw bin counts — `1000`, `5000`, `50000` — sitting
   * second in the trail. Three things were wrong with that and each of them is
   * answered here.
   *
   * **It read as a step of the trail**, which it is not: a rung is the same file
   * at a different grain, and the crumbs after it stay exactly where they were.
   * So it goes last, past the coordinates, where the controls over the picture
   * live.
   *
   * **It was in bins.** `50000` is a number a reader has to divide before it
   * means anything, and the answer — 50 kb — is the unit every other length in
   * this application is written in ({@link resolutionLabel}).
   *
   * **A dropdown hides the ladder.** A `zoomify` ladder is an *ordered* thing
   * with a fixed number of rungs, and that is exactly what a slider over labelled
   * stops shows: how many there are, which one you are on, and which way is
   * finer. Both halves write the same value — the stops are real radios, so the
   * arrow keys and a screen reader get the list, and the slider is the hand's
   * version of the same walk.
   */
  private pushResolution(): void {
    const rungs = this.ladder()
    const onSelect = this.props.onSelectEntry
    if (rungs === null || onSelect === undefined || rungs.length < 2) return
    const at = Math.max(
      0,
      rungs.findIndex((rung) => rung.name === this.props.currentEntry),
    )

    const group = `${GROUP_PREFIX}${groups++}`
    // **Past a handful of rungs the stops stop being stops.** Eleven chips is
    // six hundred pixels of breadcrumb, which pushes the place the reader is
    // looking at off the left of a laptop screen — and a `.mcool` published by
    // 4DN has eleven. Above the cap the slider carries the walk on its own and
    // one chip says where it has got to, which is the same two facts in a fifth
    // of the width; the slider is keyboard-operable in its own right, so what is
    // lost is the aim-and-click, which is what there was no room for anyway.
    const listed = rungs.length <= MAX_STOPS
    const stops = el('div', {
      class: 'res-stops',
      attrs: listed ? { role: 'radiogroup', 'aria-label': 'resolution' } : {},
    })
    const slider = el('input', {
      class: 'res-slider',
      type: 'range',
      title: `Drag to a coarser or finer resolution — ${rungs
        .map((rung) => resolutionLabel(rung.binsize))
        .join(', ')}`,
      attrs: {
        min: '0',
        max: String(rungs.length - 1),
        step: '1',
        'aria-label': 'resolution',
      },
    }) as HTMLInputElement
    slider.value = String(at)

    for (const [index, rung] of rungs.entries()) {
      if (!listed) {
        if (index !== at) continue
        stops.appendChild(
          el(
            'span',
            {
              class: 'res-stop current',
              title: `${rung.binsize.toLocaleString('en-US')} bp per bin`,
            },
            el('span', { text: resolutionLabel(rung.binsize) }),
          ),
        )
        continue
      }
      const radio = el('input', {
        class: 'res-radio',
        type: 'radio',
        attrs: { name: group, value: rung.name },
      }) as HTMLInputElement
      radio.checked = index === at
      radio.addEventListener('change', () => {
        if (radio.checked) onSelect(rung.name)
      })
      stops.appendChild(
        el(
          'label',
          {
            class: `res-stop${index === at ? ' current' : ''}`,
            title: `${rung.binsize.toLocaleString('en-US')} bp per bin`,
          },
          radio,
          el('span', { text: resolutionLabel(rung.binsize) }),
        ),
      )
    }

    // On `change`, not `input`: dragging across a five-rung ladder would
    // otherwise re-open the file at every rung it passed over, which is four
    // reads nobody asked for and a picture that flickers through them.
    slider.addEventListener('change', () => {
      const picked = rungs[Number(slider.value)]
      if (picked !== undefined && picked.name !== this.props.currentEntry) onSelect(picked.name)
    })

    this.el.appendChild(
      el(
        'div',
        {
          class: 'crumb-res',
          title:
            'How finely this file is drawn — the rungs of its own zoomify ladder. ' +
            'A coarser rung is a smaller read and a blockier picture; the place on screen does ' +
            'not change.',
        },
        el('span', { class: 'res-label', text: 'resolution' }),
        slider,
        stops,
      ),
    )
  }

  /**
   * The root crumb: a link *plus* a picker, not a picker alone.
   *
   * Making the whole crumb a `<select>` cost the trail its main job — one click
   * back to the table you came from. Going up is the common action and stays a
   * one-click link; switching table is the rare one and gets the arrow beside
   * it.
   */
  private pushRootPicker(state: ViewState): void {
    const { rootChoices, rootKind } = this.props
    const table: 'genomes' | 'cells' | 'contigs' = rootTable(state, rootKind)
    // The whole-file views belong in this crumb as much as the tables do:
    // leaving them out left them labelled "Chromosomes", so the only sign
    // anything had happened was the heatmap itself.
    const whole = state.view === 'whole' || state.view === 'overview' ? state.view : null
    const active: RootChoice = whole ?? table
    const atRoot = whole !== null || state.view === table

    this.separator()

    const labelOf = (kind: RootChoice): string =>
      kind === 'contigs' ? (this.props.contigNoun ?? ROOT_LABEL.contigs) : ROOT_LABEL[kind]

    const label = el('button', {
      class: `crumb${atRoot ? ' current' : ''}`,
      type: 'button',
      text: labelOf(active),
      title: withKey(`Back to ${labelOf(active)}`, ROOT_KEYS[active]),
    })
    label.addEventListener('click', () =>
      this.props.onNavigate({ uri: state.uri, view: active }),
    )

    if (rootChoices.length < 2) {
      this.el.appendChild(label)
      return
    }

    const other = rootChoices.filter((kind) => kind !== active).map(labelOf)
    const arrow = el('button', {
      class: 'crumb-arrow',
      type: 'button',
      title: `Switch to the ${other.join(' or ')} table`,
      attrs: { 'aria-label': 'choose which table to browse' },
    })
    arrow.appendChild(icon('chevron-down', { size: 14 }))
    const menu = el('div', { class: 'crumb-menu hidden' })
    for (const kind of rootChoices) {
      const why = this.props.disabledChoices?.[kind]
      const item = el('button', {
        class: `crumb-menu-item${kind === active ? ' current' : ''}${why === undefined ? '' : ' disabled'}`,
        type: 'button',
        text: labelOf(kind),
        title: why ?? withKey(`Go to ${labelOf(kind)}`, ROOT_KEYS[kind]),
      })
      // The key beside the word, for the entries that can be reached by one.
      // The disabled entry says why it is disabled instead: a shortcut printed
      // next to something that cannot be done is a shortcut that does nothing.
      if (why === undefined) item.appendChild(keyBadge(ROOT_KEYS[kind], { class: 'kbd-inline' }))
      if (why !== undefined) {
        item.disabled = true
      } else {
        item.addEventListener('click', () => {
          menu.classList.add('hidden')
          this.props.onNavigate({ uri: state.uri, view: kind })
        })
      }
      menu.appendChild(item)
    }
    arrow.addEventListener('click', (event) => {
      event.stopPropagation()
      const opening = menu.classList.contains('hidden')
      menu.classList.toggle('hidden', !opening)
      if (opening) {
        // Placed against the viewport from the arrow's own rect: the crumb row
        // scrolls horizontally, and a scroller clips what hangs out of it.
        const rect = arrow.getBoundingClientRect()
        menu.style.top = `${rect.bottom + 4}px`
        menu.style.left = `${rect.left}px`
        // One outside click closes it; `once` means no listener outlives the menu.
        window.addEventListener('click', () => menu.classList.add('hidden'), { once: true })
      }
    })
    this.el.appendChild(el('span', { class: 'crumb-group' }, label, arrow, menu))
  }

  /** The active root, as a label — the shell uses it for the greyed entries. */
  static label(kind: RootChoice): string {
    return ROOT_LABEL[kind]
  }

  private separator(): void {
    if (this.el.childNodes.length > 0) {
      this.el.appendChild(el('span', { class: 'crumb-sep' }, icon('chevron-right', { size: 14 })))
    }
  }

  private push(label: string, onClick?: () => void, current = false, extra = ''): void {
    this.separator()
    const className = `crumb${current ? ' current' : ''}${extra === '' ? '' : ` crumb-${extra}`}`
    // The file crumb is the one whose label does not describe what clicking it
    // does, so it is the one that has to say.
    const title = extra === 'file' ? `${label} — click to open another file` : label
    if (onClick === undefined || current) {
      this.el.appendChild(el('span', { class: className, text: label, title }))
      return
    }
    const node = el('button', { class: className, type: 'button', text: label, title })
    node.addEventListener('click', onClick)
    this.el.appendChild(node)
  }
}
