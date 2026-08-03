/**
 * Application shell and router.
 *
 * Holds the three things that outlive a view — the reader client (which owns the
 * worker, which owns all I/O), the view store (which owns the URL hash), and the
 * two tables read once at open — and swaps the view underneath them.
 *
 * Routing is a switch over `ViewState.view`; there is no route table and no
 * router library, because the whole navigable surface is five view kinds and one
 * URL hash (spec §5.5).
 */

import './ui/styles.css'

import { UNBINNED_NAME } from './constants'
import { ViewerError } from './errors'
import {
  ViewStore,
  differsOnlyInScale,
  landingState,
  parseViewState,
  viewStateEquals,
} from './state/ViewState'
import { recall, remember } from './state/UiMemory'
import type { Transform, ViewState } from './types'
import { ReaderClient } from './worker/client'
import type { ContigsResult, GenomesResult, OpenResult, SourceSpec } from './worker/protocol'
import { Breadcrumb } from './ui/Breadcrumb'
import { openCommandPalette } from './ui/CommandPalette'
import { ContigsTable } from './ui/ContigsTable'
import { ErrorView } from './ui/ErrorView'
import { FilePicker, firstEntry } from './ui/FilePicker'
import { GenomeView, type ScaleState } from './ui/GenomeView'
import { GenomesTable } from './ui/GenomesTable'
import { InfoPanel } from './ui/InfoPanel'
import { Overview } from './ui/Overview'
import { PairView } from './ui/PairView'
import { findRow, recordFields, type RecordField, type RecordSpec } from './ui/RecordCard'
import { RegionView } from './ui/RegionView'
import { WholeView } from './ui/WholeView'
import { Modal } from './ui/Modal'
import { SidebarToggle } from './ui/SidebarToggle'
import { StatusBar } from './ui/StatusBar'
import { ThemeToggle, initTheme } from './ui/ThemeToggle'
import type { TableUiState } from './ui/VirtualTable'
import { isTypingTarget, keyLabel, matchesKeys, type Command } from './ui/commands'
import { openAbout, openShortcuts } from './ui/dialogs'
import { button, el, fmt } from './ui/dom'
import { icon, iconButton } from './ui/icons'
import { demoExamples } from './ui/examples'
import { contigOf, fileLabel, neighbour, splitUri } from './ui/labels'
import { PLOT_OPTION_LABELS, getPlotOptions, togglePlotOption } from './ui/plotOptions'

/** Where "source" points, from the about dialog and the header. */
const REPO_URL = 'https://github.com/js2264/metacooler.js'

interface OpenFile {
  /**
   * The URI as *requested*, which is what the hash carries. Kept beside
   * `info.uri` because the reader may normalise its copy (`file::` → `file`),
   * and a router that compared against the normalised form would re-open the
   * file on every navigation.
   */
  uri: string
  info: OpenResult
  genomes: GenomesResult
  contigs: ContigsResult | null
  source: SourceSpec
  genomeNames: string[]
  displayNames: string[]
  /** Entry names of the enclosing mmetacool; empty for a plain metacool (§3.4). */
  entries: string[]
  /** The entry this URI names, when it addresses one. */
  currentEntry: string | undefined
}

class App {
  private readonly client = new ReaderClient()
  private readonly store = new ViewStore()
  private readonly content: HTMLElement
  private readonly breadcrumbHost: HTMLElement
  private readonly sideHost: HTMLElement
  /**
   * The right-hand column, holding whatever controls the mounted view offers.
   *
   * A shell column rather than part of the view, for the same two reasons the
   * file sidebar is one: it starts under the breadcrumb instead of below the
   * view's own heading, and it scrolls on its own instead of dragging the
   * heatmap up the page when there is one card too many.
   */
  private readonly rightHost: HTMLElement
  private readonly picker: FilePicker
  private readonly sidebar: SidebarToggle
  private readonly theme: ThemeToggle
  private readonly status: StatusBar
  /** At most one dialog at a time; it owns the keyboard while it is up. */
  private modal: Modal | null = null

  private file: OpenFile | null = null
  private breadcrumb: Breadcrumb | null = null
  private infoPanel: InfoPanel | null = null
  private overview: Overview | null = null
  private showingOverview = false
  private opening: string | null = null
  private current: { destroy?(): void; applyScale?(scale: ScaleState): void } | null = null
  /**
   * The state the mounted view was built for.
   *
   * Kept so `render` can tell a navigation from a repaint. `this.current` is the
   * view object; this is what it was built from.
   */
  private mounted: ViewState | null = null

  constructor(root: HTMLElement) {
    this.picker = new FilePicker({
      onOpen: (uri, source) => void this.open(uri, source),
      examples: demoExamples(),
    })

    this.breadcrumbHost = el('div', { class: 'breadcrumb-host' })
    this.content = el('main', { class: 'content' })
    this.sideHost = el('div', { class: 'side-host' })
    this.rightHost = el('div', { class: 'right-host' })
    this.sidebar = new SidebarToggle(this.sideHost)

    this.status = new StatusBar({ client: this.client })
    this.theme = new ThemeToggle()

    // The title is the way home. It reads as one, so it should behave as one:
    // clicking it returns to the file picker, which is the only view above
    // every other (§5.1).
    const home = button('(meta)cooler', () => this.toPicker(), {
      class: 'brand-name brand-home',
      title: 'Back to the file picker',
    })

    const palette = button('', () => this.openPalette(), { class: 'action-bar' })
    palette.replaceChildren(
      el('span', { class: 'action-bar-text', text: 'Search commands…' }),
      el('kbd', { class: 'kbd', text: keyLabel('mod+p') }),
    )
    palette.title = 'Every action in this app, searchable'

    const source = el('a', {
      class: 'btn btn-icon',
      href: REPO_URL,
      title: 'Source, issues and the format specification on GitHub',
      attrs: { target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'source on GitHub' },
    })
    source.appendChild(icon('github'))

    root.append(
      el(
        'header',
        { class: 'app-head' },
        el(
          'div',
          { class: 'head-left' },
          this.sidebar.el,
          el(
            'div',
            { class: 'brand' },
            home,
            el('span', {
              class: 'brand-sub',
              text: '(multi-genome) cool files, in the browser',
            }),
          ),
        ),
        palette,
        el(
          'div',
          { class: 'head-actions' },
          // Theme, shortcuts, source, about. No "open a file" button: the
          // title is the way back to the picker and says so on hover.
          this.theme.el,
          iconButton('keyboard', 'Keyboard shortcuts', () => this.openShortcutsDialog()),
          source,
          iconButton('info', 'About this viewer', () => this.openAboutDialog()),
        ),
      ),
      this.breadcrumbHost,
      // `side-host` also carries `order: -1`, so it renders left; keeping it
      // second in the DOM keeps the tab order content-first.
      el('div', { class: 'app-body' }, this.content, this.sideHost, this.rightHost),
      this.status.el,
    )

    window.addEventListener('keydown', (event) => this.onKeyDown(event))

    this.store.subscribe((state) => void this.render(state))
    this.store.connectHash()
    if (this.store.state === null) void this.render(null)
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Every action, rebuilt on demand so `enabled` reflects the state the user is
   * actually in. One list feeds the palette, the shortcuts dialog and the key
   * handler; a shortcut that works but is undocumented is how these rot.
   */
  private commands(): Command[] {
    const state = this.store.state
    const file = this.file
    const isMetacool = file?.info.layout.kind === 'metacool'
    const overlays = getPlotOptions()
    const list: Command[] = [
      {
        id: 'palette',
        group: 'App',
        title: 'Search commands',
        keys: 'mod+p',
        run: () => this.openPalette(),
      },
      {
        id: 'open-file',
        group: 'File',
        title: 'Open a different file',
        keys: 'o',
        run: () => this.toPicker(),
      },
      {
        id: 'go-genomes',
        group: 'Go',
        title: 'Genomes table',
        keys: 'g',
        enabled: file !== null && isMetacool,
        run: () => {
          if (state !== null) this.navigate({ uri: state.uri, view: 'genomes' })
        },
      },
      {
        id: 'go-contigs',
        group: 'Go',
        title: 'Contigs table',
        keys: 'c',
        enabled: file !== null,
        run: () => {
          if (state !== null) this.navigate({ uri: state.uri, view: 'contigs' })
        },
      },
      {
        id: 'go-overview',
        group: 'Go',
        // One question — the whole file at once — answered two ways, exactly as
        // the root menu offers it: a metacool scans every pixel to build the
        // genome x genome matrix, a cooler reads its single matrix in one
        // bounded block (§9). Binding the key to only the first left `w` dead on
        // every cool file, beside a `C` that worked.
        title: isMetacool ? 'Whole metagenome' : 'Whole genome',
        hint: isMetacool
          ? 'Costs a full pixel scan; it never starts on its own.'
          : 'One bounded read; refused if it would not fit this machine.',
        keys: 'w',
        enabled: file !== null,
        run: () => {
          if (isMetacool) this.showOverview()
          else if (state !== null) this.navigate({ uri: state.uri, view: 'whole' })
        },
      },
      {
        id: 'go-prev',
        group: 'Go',
        title: 'Previous genome or contig',
        hint: this.stepTarget(-1) ?? undefined,
        keys: '[',
        enabled: this.stepTarget(-1) !== null,
        run: () => this.step(-1),
      },
      {
        id: 'go-next',
        group: 'Go',
        title: 'Next genome or contig',
        hint: this.stepTarget(1) ?? undefined,
        keys: ']',
        enabled: this.stepTarget(1) !== null,
        run: () => this.step(1),
      },
    ]

    const overlayKeys: Array<[keyof typeof PLOT_OPTION_LABELS, string]> = [
      ['crosshair', 'x'],
      ['dividers', 'd'],
      ['breaks', 'e'],
      ['labels', 'l'],
      ['ticks', 'k'],
    ]
    for (const [key, binding] of overlayKeys) {
      list.push({
        id: `overlay-${key}`,
        group: 'View',
        title: `${overlays[key] ? 'Hide' : 'Show'} ${PLOT_OPTION_LABELS[key].label}`,
        hint: PLOT_OPTION_LABELS[key].hint,
        keys: binding,
        run: () => void togglePlotOption(key),
      })
    }

    list.push(
      {
        id: 'fold-sidebar',
        group: 'View',
        title: 'Fold or show the file info sidebar',
        keys: 'b',
        enabled: file !== null,
        run: () => this.sidebar.el.click(),
      },
      {
        id: 'theme',
        group: 'View',
        title: 'Cycle the theme: system, light, dark',
        keys: 't',
        run: () => this.theme.el.click(),
      },
      {
        id: 'shortcuts',
        group: 'Help',
        title: 'Keyboard shortcuts',
        keys: '?',
        run: () => this.openShortcutsDialog(),
      },
      { id: 'about', group: 'Help', title: 'About this viewer', run: () => this.openAboutDialog() },
      {
        id: 'source',
        group: 'Help',
        title: 'Source on GitHub',
        run: () => window.open(REPO_URL, '_blank', 'noopener'),
      },
    )
    return list
  }

  /**
   * Dispatch a keystroke.
   *
   * A dialog owns the keyboard while it is open, and anything typed into an
   * input belongs to that input — `?` and `[` are legal in a contig name, and
   * `o` is legal in every name there is. Chords survive both, because ⌘P from a
   * text box is still ⌘P.
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (this.modal !== null) return
    const typing = isTypingTarget(event.target)
    for (const command of this.commands()) {
      if (command.keys === undefined || command.enabled === false) continue
      if (typing && !command.keys.startsWith('mod+')) continue
      if (!matchesKeys(event, command.keys)) continue
      event.preventDefault()
      command.run()
      return
    }
  }

  private openPalette(): void {
    if (this.modal !== null) return
    this.modal = openCommandPalette(this.commands(), () => {
      this.modal = null
    })
  }

  private openShortcutsDialog(): void {
    if (this.modal !== null) return
    this.modal = openShortcuts(this.commands(), () => {
      this.modal = null
    })
  }

  private openAboutDialog(): void {
    if (this.modal !== null) return
    this.modal = openAbout(REPO_URL, () => {
      this.modal = null
    })
  }

  /**
   * Open a file over whatever is on screen, rather than going back to the
   * landing page for one.
   *
   * The file crumb used to *navigate* to the picker, which threw the current
   * view away to ask a question — and a user who then changed their mind had no
   * way back to the map they were reading, because the file they had dropped
   * cannot be re-opened without another gesture (§11). As a dialog it asks the
   * same question over the top: Escape, the close button or the backdrop leave
   * everything exactly as it was, and choosing a file replaces it deliberately.
   *
   * Its own {@link FilePicker}, not the one mounted in the content area: that
   * element is the landing view and moving it into a dialog would empty the
   * page behind it.
   */
  private openFileDialog(): void {
    if (this.modal !== null) return
    const modal: Modal = new Modal({
      title: 'Open a file',
      variant: 'modal-wide',
      body: () =>
        new FilePicker({
          onOpen: (uri, source) => {
            modal.close()
            void this.open(uri, source)
          },
          examples: demoExamples(),
        }).el,
      onClose: () => {
        this.modal = null
      },
    })
    this.modal = modal
  }

  // -------------------------------------------------------------------------
  // Stepping between neighbours
  // -------------------------------------------------------------------------

  /**
   * The genome or contig one step away, or `null` when there is none.
   *
   * Genomes step through the display order, which is the table's order minus
   * `__unbinned__`; contigs step through the file's own contig order, which is
   * what the contigs table shows. A two-contig block has two axes and no single
   * "next", so it does not step at all rather than picking one silently.
   */
  private stepTarget(delta: number): string | null {
    const state = this.store.state
    const file = this.file
    if (state === null || file === null) return null
    if (state.view === 'genome' && state.genome !== undefined) {
      return neighbour(file.displayNames, state.genome, delta)
    }
    if (state.view === 'region' && state.region !== undefined && state.region2 === undefined) {
      const names = this.contigNames()
      if (names === null) return null
      const current = contigOf(state.region, names)
      return current === null ? null : neighbour(names, current, delta)
    }
    return null
  }

  private step(delta: number): void {
    const state = this.store.state
    const target = this.stepTarget(delta)
    if (state === null || target === null) return
    if (state.view === 'genome') this.store.set({ uri: state.uri, view: 'genome', genome: target })
    else this.store.set({ ...state, region: target })
  }

  /** Contig names, if the contigs table has already been read. */
  private contigNames(): string[] | null {
    const table = this.file?.contigs
    if (table === undefined || table === null) return null
    const names = table.table.data['name']
    return Array.isArray(names) ? (names as string[]) : null
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  /**
   * Open a file and mount the view the caller asked for.
   *
   * `carry` is the view state a *redirect* is forwarding. Opening an `.mcool`
   * or `.mmetacool` at its root lands on one of its entries under a different
   * URI, and without carrying the request across that hop the comparison below
   * (`wanted.uri === uri`) can never match, so every shared link to a
   * collection root lost its view, genome, region and colour scale on the way
   * in (spec §5.5).
   */
  private async open(uri: string, source: SourceSpec, carry?: ViewState): Promise<void> {
    if (this.opening === uri) return
    this.opening = uri
    this.showContent(loading(`Opening ${fileLabel(uri)}`))
    try {
      const info = await this.client.request<'open'>({ kind: 'open', uri, source })
      const genomes = await this.client.request<'genomes'>({ kind: 'genomes' })
      const names = genomes.table.data['name'] as string[]
      // `entries` is non-empty only for a map inside an mmetacool; the group
      // path is what says which of them is open (§3.4).
      const entries = info.entries
      const group = splitUri(uri).group
      // `/entries/rep1` in an mmetacool, `/resolutions/1000` in an mcool.
      const match = /^\/(?:entries|resolutions)\/(.+)$/.exec(group)
      const currentEntry = match === null ? undefined : match[1]
      this.file = {
        uri,
        info,
        genomes,
        contigs: null,
        source,
        genomeNames: names,
        displayNames: Array.from(genomes.display, (index) => names[index]).filter(
          (name) => name !== UNBINNED_NAME,
        ),
        entries,
        currentEntry,
      }
      const isMetacool = info.layout.kind === 'metacool'
      this.breadcrumb = new Breadcrumb({
        rootKind: isMetacool ? 'genomes' : 'contigs',
        // A metacool offers both landing tables and the scanned whole-genome
        // view. A cooler offers its chromosomes and, when it fits, the whole
        // genome in one read — and still lists Genomes, greyed out, because
        // "this file has none" is a more useful answer than an absent entry.
        rootChoices: isMetacool
          ? ['genomes', 'contigs', 'overview']
          : ['genomes', 'contigs', 'whole'],
        ...(isMetacool
          ? {}
          : {
              disabledChoices: {
                genomes: 'A cooler holds one genome, so there is no genomes table — its chromosomes are below.',
              },
              contigNoun: 'Chromosomes',
            }),
        fileLabel: fileLabel(uri),
        entries,
        entryNoun: info.entryGroup === 'resolutions' ? 'resolution' : 'entry',
        ...(currentEntry === undefined ? {} : { currentEntry }),
        onNavigate: (state) => this.navigate(state),
        onOpenFile: () => this.openFileDialog(),
        onShowOverview: () => this.showOverview(),
        onSelectEntry: (entry) =>
          void this.open(
            `${splitUri(uri).path}::${info.entryGroup || 'entries'}/${entry}`,
            source,
          ),
      })
      this.infoPanel = new InfoPanel({ info })
      this.sideHost.replaceChildren(this.infoPanel.el)
      this.sidebar.setAvailable(true)
      this.status.reset()
      this.overview = null
      this.showingOverview = false

      // A link may already have named a view inside this file (§5.5); honour it
      // rather than bouncing the recipient to the landing table.
      const rootView = info.layout.kind === 'metacool' ? 'genomes' : 'contigs'
      const wanted = carry ?? this.store.state
      const target =
        wanted !== null && wanted.uri === uri ? wanted : landingState(uri, rootView)
      const willNotify = !viewStateEquals(target, this.store.state)
      this.store.set(target, { replace: true })
      // `set` is a no-op when the state is already exactly `target`, so render
      // explicitly in that case — and only in that case, to avoid mounting the
      // same view twice.
      if (!willNotify) void this.render(target)
    } catch (err) {
      // An `.mmetacool` opened at its root is a `KeyError` in Python, and the
      // reader mirrors that faithfully (§3.4). But a *user* who dropped a
      // collection meant "show me this data", so the app answers by opening an
      // entry and offering the rest in the breadcrumb picker, rather than
      // handing back an error about a URI syntax they did not use.
      const landing = firstEntry(err)
      if (landing !== null) {
        const entryUri = `${splitUri(uri).path}::${landing.group}/${landing.entry}`
        // The request was made against the collection's root URI; the file that
        // answers it is one of its entries. Rewriting the URI is the whole of
        // the translation — a region, a colour clip and a level all mean the
        // same thing inside the entry as they did in the link.
        const requested = carry ?? this.store.state
        const forward =
          requested !== null && requested.uri === uri ? { ...requested, uri: entryUri } : undefined
        this.opening = null
        await this.open(entryUri, source, forward)
        return
      }
      this.showError(err, uri, source)
    } finally {
      this.opening = null
    }
  }

  /**
   * Whether this file is shown balanced, and in `log10`, unless the state says
   * otherwise.
   *
   * True for a **cooler that carries weights**, and only there. A `.cool` is a
   * finished assembly whose map is read for structure — compartments, loops,
   * the decay with distance — and all three are claims about *relative*
   * contact frequency, which is what balancing produces and raw counts, with
   * their per-bin coverage still in them, do not. The two go together: balanced
   * values are fractions spanning orders of magnitude below 1, so `log10` is
   * the transform that spreads them and `log1p` the one that flattens them into
   * the bottom of the scale.
   *
   * A `.metacool` keeps `metacooler show`'s defaults — raw counts, `log1p` —
   * because §7.1 parity is the point there, and because a MAG's map is usually
   * read for *how much* two contigs touch, which is a count.
   *
   * With no weight column there is nothing to balance, so such a cooler keeps
   * the CLI defaults too rather than being handed half of a pair.
   */
  private balancedByDefault(): boolean {
    const info = this.file?.info
    return info !== undefined && !info.hasGenomes && info.hasWeights
  }

  /** The balance in force: the state's choice, else the file's default. */
  private balanceOf(state: ViewState): boolean {
    return state.balance ?? this.balancedByDefault()
  }

  /**
   * Record a balance choice, writing it to the hash only when it *differs* from
   * the file's default — so a link stays clean, and "off" on a file that
   * defaults to on survives being shared, which `balance: balance || undefined`
   * could not express.
   */
  private setBalance(balance: boolean): void {
    this.store.patch({ balance: balance === this.balancedByDefault() ? undefined : balance })
  }

  /** The colour scale in force: the state's fields over the file's defaults. */
  private scaleOf(state: ViewState): ScaleState {
    return scaleOf(state, this.balancedByDefault() ? { transform: 'log10' } : {})
  }

  /**
   * Filter/sort memory for one table, scoped to the open file.
   *
   * Deliberately *not* in the URL: a shared link that silently carried "only
   * rows where completeness > 90" would mislead whoever opened it. But leaving
   * a filtered table to look at a genome and coming back to an unfiltered one
   * means retyping rather than thinking, so it is remembered here instead.
   */
  private tableMemory(uri: string, scope: string): {
    initial: TableUiState | null
    save(state: TableUiState): void
  } {
    return {
      initial: recall<TableUiState>(uri, `table:${scope}`),
      save: (state) => remember(uri, `table:${scope}`, state),
    }
  }

  private async contigs(): Promise<ContigsResult> {
    const file = this.file
    if (file === null) throw new Error('no file open')
    if (file.contigs === null) {
      file.contigs = await this.client.request<'contigs'>({ kind: 'contigs' })
    }
    return file.contigs
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private async render(state: ViewState | null): Promise<void> {
    if (state === null) {
      this.file = null
      this.mounted = null
      this.breadcrumb = null
      this.sideHost.replaceChildren()
      this.sidebar.setAvailable(false)
      this.showContent(this.picker.el)
      return
    }

    if (this.file === null || this.file.uri !== state.uri) {
      if (this.opening !== null) return
      const source = inferSource(state.uri)
      if (source === null) {
        this.showContent(this.pickerWithNote(state.uri))
        return
      }
      await this.open(state.uri, source)
      return
    }

    // A cooler has no genome layer (§9), and `genomes` is both the parse
    // default for a hash with no `view=` and the fallback of every incomplete
    // view below. Rewriting it here — rather than at each of those sites —
    // covers the shared link, the hand-edited hash and the three redirects at
    // once, and leaves nobody on an empty table with no way off it.
    // A link can carry `balance=true` to a file with no weight column; every
    // read would then be refused for a reason the recipient did not choose.
    if (state.balance === true && this.file !== null && !this.file.info.hasWeights) {
      this.store.set({ ...state, balance: undefined }, { replace: true })
      return
    }

    if (state.view === 'genomes' && this.file !== null && !this.file.info.hasGenomes) {
      this.store.set({ uri: state.uri, view: 'contigs' }, { replace: true })
      return
    }

    // A colour change is a repaint, not a navigation.
    //
    // Every control in the colour card patches the view state so the URL stays
    // shareable, and the store notifies for it like any other change. Without
    // this branch that notification fell straight through to the `switch`
    // below, which builds a *new* view whose constructor re-reads the matrix
    // from the worker — so nudging a clip bound ten times cost thirty worker
    // round trips, ten matrix re-reads and ten full DOM rebuilds, for a picture
    // whose data never changed.
    //
    // `applyScale` rather than "do nothing": the change does not always come
    // from the panel. A pasted link or the back button moves the *hash* first,
    // and the mounted panel has to follow it.
    if (this.mounted !== null && this.current !== null && differsOnlyInScale(this.mounted, state)) {
      this.current.applyScale?.(this.scaleOf(state))
      this.mounted = state
      this.breadcrumb?.render(state, { overview: this.showingOverview })
      this.status.refresh()
      return
    }

    this.breadcrumb?.render(state, { overview: this.showingOverview })
    this.breadcrumbHost.replaceChildren(this.breadcrumb?.el ?? el('div'))
    this.mounted = state

    if (this.showingOverview) {
      this.infoPanel?.setRecords([])
      this.mountOverview()
      return
    }

    switch (state.view) {
      case 'genomes':
        this.mountGenomes(state)
        break
      case 'contigs':
        await this.mountContigs(state)
        break
      case 'genome':
        this.mountGenome(state)
        break
      case 'pair':
        this.mountPair(state)
        break
      case 'region':
        await this.mountRegion(state)
        break
      case 'whole':
        this.mountWhole(state)
        break
    }
    // After the switch, not before: a region view reads the contigs table on the
    // way in, and there is no row to show until it has arrived.
    this.infoPanel?.setRecords(this.recordsFor(state))
    this.status.refresh()
  }

  // -------------------------------------------------------------------------
  // The sidebar record card
  // -------------------------------------------------------------------------

  /**
   * The `/genomes` or `/contigs` row(s) the current view is a picture of.
   *
   * Only the heatmap views have one: a *table* view already shows every row of
   * the table the card would quote, and the whole-genome view of a cooler is a
   * picture of the file rather than of any single row.
   *
   * A two-axis view yields two records, labelled by axis. `contig_A × contig_B`
   * is the phage–host block, and which of the two is on which axis is exactly
   * what one is trying to keep straight while reading it.
   */
  private recordsFor(state: ViewState): RecordSpec[] {
    const file = this.file
    if (file === null) return []
    const noun = file.info.hasGenomes ? 'Contig' : 'Chromosome'
    switch (state.view) {
      case 'genome':
        return compact([this.genomeRecord(state.genome, 'Genome')])
      case 'pair':
        return compact([
          this.genomeRecord(state.genome, 'Genome (rows)'),
          this.genomeRecord(state.genome2, 'Genome (columns)'),
        ])
      case 'region':
        return state.region2 === undefined
          ? compact([this.contigRecord(state.region, noun)])
          : compact([
              this.contigRecord(state.region, `${noun} (rows)`),
              this.contigRecord(state.region2, `${noun} (columns)`),
            ])
      default:
        return []
    }
  }

  /** One `/genomes` row, plus the density proxy the genomes table also shows. */
  private genomeRecord(name: string | undefined, heading: string): RecordSpec | null {
    const file = this.file
    if (file === null || name === undefined) return null
    const payload = file.genomes.table
    const row = findRow(payload, name)
    if (row < 0) return null
    const density = file.genomes.density[row]
    return {
      heading,
      name,
      fields: recordFields(payload, row, {
        extra:
          density === undefined
            ? []
            : [
                {
                  key: 'nnz rows',
                  value: fmt.int(density),
                  title:
                    'Non-zero pixels whose row bin falls inside this genome ' +
                    '(bin1_offset[hi] − bin1_offset[lo]). A density proxy — NOT a contact count.',
                },
              ],
      }),
    }
  }

  /**
   * One `/contigs` row.
   *
   * The view state carries a *region*, which may narrow the contig to
   * coordinates; the row is the contig's, so `contigOf` strips the suffix — and
   * strips it the same careful way the rest of the app does, since a contig may
   * legally be named `NODE_1:2`.
   *
   * `genome_id` is replaced by the genome's name wherever it resolves: the
   * integer is an index into `/genomes`, which is not something a reader of this
   * card can look up.
   */
  private contigRecord(region: string | undefined, heading: string): RecordSpec | null {
    const file = this.file
    const payload = file?.contigs?.table
    if (file === null || payload === undefined || region === undefined) return null
    const names = payload.data['name']
    const name = Array.isArray(names) ? contigOf(region, names) : null
    if (name === null) return null
    const row = findRow(payload, name)
    if (row < 0) return null
    const ids = payload.data['genome_id']
    const id = ids === undefined || Array.isArray(ids) ? undefined : ids[row]
    const genome = id === undefined ? undefined : file.genomeNames[id]
    return {
      heading,
      name,
      fields: recordFields(payload, row, {
        // The raw index goes only when there is a name to put in its place, and
        // on a cooler, whose synthesised single genome is noise here for the
        // same reason the contigs table hides the column on one.
        skip: genome !== undefined || !file.info.hasGenomes ? ['genome_id'] : [],
        lead: file.info.hasGenomes && genome !== undefined ? [genomeField(genome)] : [],
      }),
    }
  }

  /**
   * File and genome context for the exported figure's caption.
   *
   * The panel can say what it drew — bin size, transform, level — but not what
   * it drew it *from*; that is the router's, because the uri and the genome are
   * view state.
   */
  private captionFor(state: ViewState): { file: string; genome?: string } {
    return {
      file: fileLabel(state.uri),
      ...(state.genome === undefined ? {} : { genome: state.genome }),
    }
  }

  private mountGenomes(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const view = new GenomesTable({
      data: file.genomes,
      persistence: this.tableMemory(state.uri, 'genomes'),
      onOpenGenome: (genome) => this.store.set({ uri: state.uri, view: 'genome', genome }),
      onOpenPair: (a, b) =>
        this.store.set({ uri: state.uri, view: 'pair', genome: a, genome2: b }),
    })
    this.showContent(view.el)
  }

  private async mountContigs(state: ViewState): Promise<void> {
    const file = this.file
    if (file === null) return
    const data = await this.contigs()
    // A plain cooler is opened as itself: no genome layer, no genome_id column,
    // and the chrom table is the landing view rather than a consolation prize.
    const cooler = !file.info.hasGenomes
    const view = new ContigsTable({
      data,
      hideColumns: cooler ? ['genome_id'] : [],
      title: cooler ? 'Chromosomes' : 'Contigs',
      hint: cooler
        ? 'One genome, its chromosomes. Pick one to browse it, or open the whole genome at once ' +
          'from the menu beside the crumb — that one is offered whenever the estimate says this ' +
          'machine can hold it.'
        : undefined,
      persistence: this.tableMemory(state.uri, 'contigs'),
      onOpenContig: (contig) =>
        this.store.set({ uri: state.uri, view: 'region', region: contig, genome: state.genome }),
    })
    this.showContent(view.el)
  }

  private mountWhole(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const view = new WholeView({
      client: this.client,
      caption: this.captionFor(state),
      binsize: file.info.binsize ?? 1,
      nBins: file.info.nBins,
      level: state.level ?? 'bin',
      scale: this.scaleOf(state),
      balance: this.balanceOf(state),
      hasWeights: file.info.hasWeights,
      // Offered for a cooler too, now that the roll-up accumulates from the
      // stored pixels: a chromosome-level whole-genome view of yeast is 17 x 17
      // cells and always fits, which makes it the honest answer when the
      // bin-level block does not. It is only meaningless on a file with one
      // sequence, where every level is a single cell.
      offerLevel: file.info.nContigs > 1,
      noun: file.info.hasGenomes ? 'contig' : 'chromosome',
      onLevelChange: (level) => this.store.patch({ level }, { replace: true }),
      onBalanceChange: (balance) => this.setBalance(balance),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenRegion: (region, region2) =>
        this.store.set({
          uri: state.uri,
          view: 'region',
          region,
          ...(region2 === undefined ? {} : { region2 }),
        }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  private mountGenome(state: ViewState): void {
    if (state.genome === undefined) {
      this.store.set({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const view = new GenomeView({
      client: this.client,
      caption: this.captionFor(state),
      binsize: this.file?.info.binsize ?? 1,
      genome: state.genome,
      balance: this.balanceOf(state),
      hasWeights: this.file?.info.hasWeights === true,
      onBalanceChange: (balance) => this.setBalance(balance),
      neighbours: { prev: this.stepTarget(-1), next: this.stepTarget(1) },
      onStep: (delta) => this.step(delta),
      level: state.level ?? 'bin',
      scale: this.scaleOf(state),
      onLevelChange: (level) => this.store.patch({ level }, { replace: true }),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenRegion: (region) =>
        this.store.set({ uri: state.uri, view: 'region', region, genome: state.genome }),
      onOpenContigPair: (region, region2) =>
        this.store.set({ uri: state.uri, view: 'region', region, region2, genome: state.genome }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  private mountPair(state: ViewState): void {
    const file = this.file
    if (file === null) return
    if (state.genome === undefined || state.genome2 === undefined) {
      this.store.set({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const view = new PairView({
      client: this.client,
      caption: this.captionFor(state),
      binsize: file.info.binsize ?? 1,
      genomeNames: file.displayNames,
      balance: this.balanceOf(state),
      hasWeights: file.info.hasWeights,
      onBalanceChange: (balance) => this.setBalance(balance),
      rowGenome: state.genome,
      colGenome: state.genome2,
      level: state.level ?? 'bin',
      scale: this.scaleOf(state),
      onChangeGenomes: (genome, genome2) => this.store.set({ ...state, genome, genome2 }),
      onLevelChange: (level) => this.store.patch({ level }, { replace: true }),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenGenome: (genome) => this.store.set({ uri: state.uri, view: 'genome', genome }),
      onOpenContig: (region) => this.store.set({ uri: state.uri, view: 'region', region }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  private async mountRegion(state: ViewState): Promise<void> {
    if (state.region === undefined) {
      this.store.set({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    // The contigs table is what "next contig" steps through. It is read once
    // per file and cached, so this costs a read on the first region view and
    // nothing afterwards.
    if (this.file?.contigs == null) await this.contigs().catch(() => null)
    if (this.store.state !== state) return
    const view = new RegionView({
      client: this.client,
      caption: this.captionFor(state),
      binsize: this.file?.info.binsize ?? 1,
      region: state.region,
      noun: this.file?.info.hasGenomes === false ? 'chromosome' : 'contig',
      balance: this.balanceOf(state),
      hasWeights: this.file?.info.hasWeights === true,
      onBalanceChange: (balance) => this.setBalance(balance),
      neighbours: { prev: this.stepTarget(-1), next: this.stepTarget(1) },
      onStep: (delta) => this.step(delta),
      ...(state.region2 === undefined ? {} : { region2: state.region2 }),
      scale: this.scaleOf(state),
      // Typing a new region replaces the whole selection, so the second axis
      // goes with it: `contig_A × contig_B` then `contig_C` means contig_C, not
      // contig_C against a column the user can no longer see named anywhere.
      // Built by omission rather than `region2: undefined`, so the state object
      // has no undefined-valued keys for a strict deep-equal to trip on.
      onChangeRegion: (region) => {
        const { region2: _dropped, ...rest } = state
        this.store.set({ ...rest, region })
      },
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenGenome: (genome) => this.store.set({ uri: state.uri, view: 'genome', genome }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  private showOverview(): void {
    if (this.showingOverview) return
    this.showingOverview = true
    void this.render(this.store.state)
  }

  /**
   * Go to a view state, leaving the whole-genome view if it is up.
   *
   * `store.set` is a no-op when the state is unchanged — picking "Genomes" from
   * the root menu while already *at* `view=genomes` with the overview over it is
   * exactly that case — so the render is forced rather than awaited.
   */
  private navigate(state: ViewState): void {
    const same = viewStateEquals(state, this.store.state)
    const leaving = this.showingOverview
    this.showingOverview = false
    this.store.set(state)
    if (same && leaving) void this.render(state)
  }

  private mountOverview(): void {
    const file = this.file
    if (file === null) return
    if (this.overview === null) {
      const edges = new URLSearchParams(window.location.search).get('edges')
      this.overview = new Overview({
        client: this.client,
        caption: { file: fileLabel(file.uri) },
          binsize: file.info.binsize ?? 1,
        sourceKind: file.info.sourceKind,
        sourceBytes: file.info.sourceBytes,
        edgeListUrl: edges ?? undefined,
        onOpenPair: (a, b) => {
          this.showingOverview = false
          this.store.set({ uri: file.uri, view: 'pair', genome: a, genome2: b })
        },
        onOpenGenome: (genome) => {
          this.showingOverview = false
          this.store.set({ uri: file.uri, view: 'genome', genome })
        },
        onOpenContig: (region, region2) => {
          this.showingOverview = false
          this.store.set({
            uri: file.uri,
            view: 'region',
            region,
            ...(region2 === undefined ? {} : { region2 }),
          })
        },
        onError: (err) => this.showError(err),
      })
    }
    // Its own controls, but *not* as the current view: the overview is cached
    // across navigations and `showContent` destroys what it replaces.
    this.showContent(this.overview.el)
    this.rightHost.replaceChildren(this.overview.sideEl)
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  /**
   * Show the file picker.
   *
   * `store.set(null)` is a no-op when the state is *already* null, which is
   * precisely the case after a file failed to open from the picker: the failure
   * never became a view state, so the store never left it. "Open another file"
   * then did nothing at all. Rendering directly is the only thing that can
   * work, because there is no transition to notify about.
   */
  private toPicker(): void {
    if (this.store.state === null) void this.render(null)
    else this.store.set(null)
  }

  private showContent(
    node: HTMLElement,
    view?: { destroy?(): void; sideEl?: HTMLElement },
  ): void {
    this.current?.destroy?.()
    this.current = view ?? null
    this.content.replaceChildren(node)
    // Emptied rather than hidden when a view has no controls: `:empty` is what
    // takes the column's width back for the table views.
    if (view?.sideEl === undefined) this.rightHost.replaceChildren()
    else this.rightHost.replaceChildren(view.sideEl)
  }

  private pickerWithNote(uri: string): HTMLElement {
    return el(
      'div',
      { class: 'view' },
      el('p', {
        class: 'inline-error',
        text:
          `This link points at ${fileLabel(uri)}, which is not a URL this page can fetch — it names ` +
          'a local file. Drop the same file below to follow the link; the rest of the view (genome, ' +
          'region, colour scale) will be restored.',
      }),
      this.picker.el,
    )
  }

  private showError(err: unknown, uri?: string, source?: SourceSpec): void {
    const entries =
      err instanceof ViewerError && Array.isArray(err.detail['entries'])
        ? (err.detail['entries'] as string[])
        : []
    const view = new ErrorView({
      error: err,
      onOpenFilePicker: () => this.toPicker(),
      onOpenEntry:
        entries.length > 0 && uri !== undefined && source !== undefined
          ? (entry) => void this.open(`${splitUri(uri).path}::entries/${entry}`, source)
          : undefined,
    })
    this.showContent(view.el)
  }
}

/**
 * The waiting state, centred in the content area.
 *
 * Opening a remote map is a few round trips before anything can be drawn, and a
 * line of grey text at the top left reads as a page that failed rather than one
 * that is working. The spinner is CSS, so it costs nothing and keeps moving
 * while the worker is busy — a frozen indicator would be worse than none.
 */
/**
 * The genome a contig belongs to, named as the rest of the app names it.
 *
 * `__unbinned__` is not a genome and §7.4 keeps it invisible everywhere but the
 * one QC statistic in the info panel — so a contig that binning failed to place
 * says *unassigned* here rather than quoting the reserved name back. The
 * distinction is the point: the contig is real and its map is worth looking at;
 * the thing it belongs to is not a bin.
 */
function genomeField(genome: string): RecordField {
  if (genome !== UNBINNED_NAME) return { key: 'genome', value: genome }
  return {
    key: 'genome',
    value: 'unassigned',
    title: 'Binning placed this contig in no genome. See Binning QC above.',
  }
}

/** Drop the records that could not be resolved to a row. */
function compact(records: Array<RecordSpec | null>): RecordSpec[] {
  return records.filter((record): record is RecordSpec => record !== null)
}

function loading(message: string): HTMLElement {
  return el(
    'div',
    { class: 'loading' },
    el('div', { class: 'spinner', attrs: { role: 'progressbar', 'aria-label': message } }),
    el('p', { class: 'loading-text', text: `${message}…` }),
  )
}

/**
 * Colour-scale fields carried by a view state (§5.5), over the file's defaults.
 *
 * Only the transform has a per-file default, and only one file has it: see
 * {@link App.balancedByDefault}. Everything else absent means the §7.1 default,
 * which `MatrixPanel` supplies.
 */
function scaleOf(state: ViewState, fallback: { transform?: Transform } = {}): ScaleState {
  const scale: ScaleState = {}
  if (fallback.transform !== undefined) scale.transform = fallback.transform
  if (state.transform !== undefined) scale.transform = state.transform
  if (state.colormap !== undefined) scale.colormap = state.colormap
  if (state.vmin !== undefined) scale.vmin = state.vmin
  if (state.vmax !== undefined) scale.vmax = state.vmax
  return scale
}

/**
 * Work out how to obtain the bytes for a URI that arrived in a link.
 *
 * A remote URL is re-openable from the hash alone; a local file is not — the
 * browser gives no way to re-read a dropped file without another gesture, which
 * is a privacy property rather than a limitation. Returning `null` sends the
 * user to the picker with an explanation.
 */
function inferSource(uri: string): SourceSpec | null {
  const { path } = splitUri(uri)
  return /^https?:\/\//i.test(path) ? { kind: 'remote', url: path } : null
}

// Before the app mounts, so a user who chose dark gets no flash of light.
initTheme()

const root = document.getElementById('app')
if (root !== null) {
  // A hash that carries no `uri` is not a view state; clear it so the picker
  // does not leave a stale fragment in the address bar.
  if (window.location.hash !== '' && parseViewState(window.location.hash) === null) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  new App(root)
}
