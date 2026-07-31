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
import { ViewStore, landingState, parseViewState, viewStateEquals } from './state/ViewState'
import { recall, remember } from './state/UiMemory'
import type { ViewState } from './types'
import { ReaderClient } from './worker/client'
import type { ContigsResult, GenomesResult, OpenResult, SourceSpec } from './worker/protocol'
import { Breadcrumb } from './ui/Breadcrumb'
import { ContigsTable } from './ui/ContigsTable'
import { ErrorView } from './ui/ErrorView'
import { FilePicker } from './ui/FilePicker'
import { GenomeView, type ScaleState } from './ui/GenomeView'
import { GenomesTable } from './ui/GenomesTable'
import { InfoPanel } from './ui/InfoPanel'
import { Overview } from './ui/Overview'
import { PairView } from './ui/PairView'
import { RegionView } from './ui/RegionView'
import type { TableUiState } from './ui/VirtualTable'
import { button, el } from './ui/dom'
import { fileLabel, splitUri } from './ui/labels'

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
  private readonly overviewButton: HTMLButtonElement
  private readonly picker: FilePicker

  private file: OpenFile | null = null
  private breadcrumb: Breadcrumb | null = null
  private infoPanel: InfoPanel | null = null
  private overview: Overview | null = null
  private showingOverview = false
  private opening: string | null = null
  private current: { destroy?(): void } | null = null

  constructor(root: HTMLElement) {
    this.picker = new FilePicker({ onOpen: (uri, source) => void this.open(uri, source) })

    this.breadcrumbHost = el('div', { class: 'breadcrumb-host' })
    this.content = el('main', { class: 'content' })
    this.sideHost = el('div', { class: 'side-host' })
    this.overviewButton = button('genome × genome overview', () => this.toggleOverview(), {
      class: 'btn btn-quiet',
      title: 'Costs a full pixel scan — it never starts on its own (§7.3).',
    })
    this.overviewButton.hidden = true

    const infoToggle = button('info', () => this.sideHost.classList.toggle('collapsed'), {
      class: 'btn btn-quiet',
    })

    root.append(
      el(
        'header',
        { class: 'app-head' },
        el(
          'div',
          { class: 'brand' },
          el('span', { class: 'brand-name', text: 'metacooler' }),
          el('span', { class: 'brand-sub', text: 'multi-genome Hi-C, in the browser' }),
        ),
        el('div', { class: 'head-actions' }, this.overviewButton, infoToggle),
      ),
      this.breadcrumbHost,
      // `side-host` also carries `order: -1`, so it renders left; keeping it
      // second in the DOM keeps the tab order content-first.
      el('div', { class: 'app-body' }, this.content, this.sideHost),
      el('footer', { class: 'app-foot' },
        el('span', { text: 'Files are read in place. Nothing is uploaded, and there is no server.' }),
      ),
    )

    this.store.subscribe((state) => void this.render(state))
    this.store.connectHash()
    if (this.store.state === null) void this.render(null)
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  private async open(uri: string, source: SourceSpec): Promise<void> {
    if (this.opening === uri) return
    this.opening = uri
    this.showContent(el('div', { class: 'loading', text: `opening ${fileLabel(uri)}…` }))
    try {
      const info = await this.client.request<'open'>({ kind: 'open', uri, source })
      const genomes = await this.client.request<'genomes'>({ kind: 'genomes' })
      const names = genomes.table.data['name'] as string[]
      // `entries` is non-empty only for a map inside an mmetacool; the group
      // path is what says which of them is open (§3.4).
      const entries = info.entries
      const group = splitUri(uri).group
      const match = /^\/entries\/(.+)$/.exec(group)
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
        // A metacool offers both landing tables; a plain cooler has only one
        // worth showing, since its genomes table is a synthesised single row.
        rootChoices: isMetacool ? ['genomes', 'contigs'] : ['contigs'],
        fileLabel: fileLabel(uri),
        entries,
        ...(currentEntry === undefined ? {} : { currentEntry }),
        onNavigate: (state) => this.store.set(state),
        onOpenFilePicker: () => this.store.set(null),
        onSelectEntry: (entry) =>
          void this.open(`${splitUri(uri).path}::entries/${entry}`, source),
      })
      this.infoPanel = new InfoPanel({ client: this.client, info })
      this.sideHost.replaceChildren(this.infoPanel.el)
      this.overviewButton.hidden = info.layout.kind !== 'metacool'
      this.overview = null
      this.showingOverview = false

      // A link may already have named a view inside this file (§5.5); honour it
      // rather than bouncing the recipient to the landing table.
      const rootView = info.layout.kind === 'metacool' ? 'genomes' : 'contigs'
      const wanted = this.store.state
      const target =
        wanted !== null && wanted.uri === uri ? wanted : landingState(uri, rootView)
      const willNotify = !viewStateEquals(target, this.store.state)
      this.store.set(target, { replace: true })
      // `set` is a no-op when the state is already exactly `target`, so render
      // explicitly in that case — and only in that case, to avoid mounting the
      // same view twice.
      if (!willNotify) void this.render(target)
    } catch (err) {
      this.showError(err, uri, source)
    } finally {
      this.opening = null
    }
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
      this.breadcrumb = null
      this.sideHost.replaceChildren()
      this.overviewButton.hidden = true
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

    this.breadcrumb?.render(state)
    this.breadcrumbHost.replaceChildren(this.breadcrumb?.el ?? el('div'))

    if (this.showingOverview) {
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
        this.mountRegion(state)
        break
    }
    this.infoPanel?.refreshStats()
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
    const synthesised = file.info.layout.kind !== 'metacool'
    const view = new ContigsTable({
      data,
      hideColumns: synthesised ? ['genome_id'] : [],
      title: synthesised ? 'Chromosomes / contigs' : 'Contigs',
      hint: synthesised
        ? 'This file is a plain cooler, so there is no genome hierarchy to browse: pick a sequence, ' +
          'or type a region below it. Whole-genome views of standard Hi-C are deliberately out of scope.'
        : undefined,
      persistence: this.tableMemory(state.uri, 'contigs'),
      onOpenContig: (contig) =>
        this.store.set({ uri: state.uri, view: 'region', region: contig, genome: state.genome }),
    })
    this.showContent(view.el)
  }

  private mountGenome(state: ViewState): void {
    if (state.genome === undefined) {
      this.store.set({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const view = new GenomeView({
      client: this.client,
      binsize: this.file?.info.binsize ?? 1,
      genome: state.genome,
      level: state.level ?? 'bin',
      scale: scaleOf(state),
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
      binsize: file.info.binsize ?? 1,
      genomeNames: file.displayNames,
      rowGenome: state.genome,
      colGenome: state.genome2,
      level: state.level ?? 'bin',
      scale: scaleOf(state),
      onChangeGenomes: (genome, genome2) => this.store.set({ ...state, genome, genome2 }),
      onLevelChange: (level) => this.store.patch({ level }, { replace: true }),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenGenome: (genome) => this.store.set({ uri: state.uri, view: 'genome', genome }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  private mountRegion(state: ViewState): void {
    if (state.region === undefined) {
      this.store.set({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const view = new RegionView({
      client: this.client,
      binsize: this.file?.info.binsize ?? 1,
      region: state.region,
      ...(state.region2 === undefined ? {} : { region2: state.region2 }),
      scale: scaleOf(state),
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

  private toggleOverview(): void {
    this.showingOverview = !this.showingOverview
    void this.render(this.store.state)
  }

  private mountOverview(): void {
    const file = this.file
    if (file === null) return
    if (this.overview === null) {
      const edges = new URLSearchParams(window.location.search).get('edges')
      this.overview = new Overview({
        client: this.client,
          binsize: file.info.binsize ?? 1,
        sourceKind: file.info.sourceKind,
        sourceBytes: file.info.sourceBytes,
        edgeListUrl: edges ?? undefined,
        onOpenPair: (a, b) => {
          this.showingOverview = false
          this.store.set({ uri: file.uri, view: 'pair', genome: a, genome2: b })
        },
        onError: (err) => this.showError(err),
      })
    }
    this.showContent(this.overview.el)
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  private showContent(node: HTMLElement, view?: { destroy?(): void }): void {
    this.current?.destroy?.()
    this.current = view ?? null
    this.content.replaceChildren(node)
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
      onOpenFilePicker: () => this.store.set(null),
      onOpenEntry:
        entries.length > 0 && uri !== undefined && source !== undefined
          ? (entry) => void this.open(`${splitUri(uri).path}::entries/${entry}`, source)
          : undefined,
    })
    this.showContent(view.el)
  }
}

/** Colour-scale fields carried by a view state (§5.5). */
function scaleOf(state: ViewState): ScaleState {
  const scale: ScaleState = {}
  if (state.transform !== undefined) scale.transform = state.transform
  if (state.colormap !== undefined) scale.colormap = state.colormap
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

const root = document.getElementById('app')
if (root !== null) {
  // A hash that carries no `uri` is not a view state; clear it so the picker
  // does not leave a stale fragment in the address bar.
  if (window.location.hash !== '' && parseViewState(window.location.hash) === null) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  new App(root)
}
