/**
 * One session: a file, the views of it, and everything that outlives a
 * navigation inside it.
 *
 * This is the object the app used to *be*. It held the reader client (which owns
 * the worker, which owns all I/O), the view store (which owned the URL hash),
 * the two tables read once at open, and the annotation stores — and it swapped
 * the view underneath them. All of that is still here, unchanged in substance;
 * what left is the window furniture, which is now {@link App}'s, because a
 * header, three columns and one address bar are shared by every session and a
 * file is not.
 *
 * The split is what makes tabs possible, and it is the whole of what makes them
 * possible: two sessions are two of these, each with its own worker, its own
 * stores and its own DOM, and the shell shows one of them at a time. Nothing
 * here is a singleton and nothing here reads `window.location` — a session that
 * did either would work perfectly until the second tab was opened.
 *
 * Routing is a switch over `ViewState.view`; there is no route table and no
 * router library, because the whole navigable surface is eight view kinds and
 * one URL hash (spec §5.5).
 */

import { AnnotationLoader } from '../annotations/loader'
import { ManualStore } from '../annotations/manual'
import { AnnotationStore } from '../annotations/store'
import { AnnotationClient } from '../annotations/worker/client'
import { UNBINNED_NAME } from '../constants'
import { ViewerError } from '../errors'
import {
  ViewStore,
  differsOnlyInScale,
  landingState,
  matrixLevel,
  overviewLevel,
  selectionOf,
  viewStateEquals,
  type UnitSelection,
} from '../state/ViewState'
import { recall, remember } from '../state/UiMemory'
import type { Transform, ViewState } from '../types'
import { ReaderClient } from '../worker/client'
import type { ContigsResult, GenomesResult, OpenResult, SourceSpec } from '../worker/protocol'
import { AnnotationCard } from '../ui/AnnotationCard'
import { Breadcrumb } from '../ui/Breadcrumb'
import { ManualCard, type MapPicker } from '../ui/ManualCard'
import type { AnnotationContext, MatrixPanel } from '../ui/MatrixPanel'
import { ContigsTable } from '../ui/ContigsTable'
import { ErrorView } from '../ui/ErrorView'
import { FilePicker, firstEntry } from '../ui/FilePicker'
import { GenomeView, type ScaleState } from '../ui/GenomeView'
import { GenomesTable } from '../ui/GenomesTable'
import { InfoPanel } from '../ui/InfoPanel'
import { Overview } from '../ui/Overview'
import { PairView } from '../ui/PairView'
import { findRow, recordFields, type RecordField, type RecordSpec } from '../ui/RecordCard'
import { RegionView } from '../ui/RegionView'
import { WholeView } from '../ui/WholeView'
import type { TableUiState } from '../ui/VirtualTable'
import type { Command } from '../ui/commands'
import { el, fmt } from '../ui/dom'
import { demoAnnotationsFor, demoExamples } from '../ui/examples'
import { contigOf, fileLabel, neighbour, splitUri } from '../ui/labels'

/**
 * What the shell does for a session, and the only direction the coupling runs.
 *
 * A session never reaches for the window: it says what changed and the shell
 * decides whether that is worth a tab label, a hash write or nothing at all,
 * because the answer depends on whether this session is the one on screen —
 * which is knowledge a session deliberately does not have.
 */
export interface SessionHost {
  /** The label, the busy state or the file changed; repaint the tab. */
  sessionChanged(session: Session): void
  /** The view state moved; mirror it into the address bar if this is active. */
  stateChanged(session: Session, options: { replace: boolean }): void
  /** Which of the three columns this session offers changed. */
  panelsChanged(session: Session): void
  /** Ask for a file over the top of whatever is on screen (§11). */
  openFileDialog(session: Session): void
  /** A read finished; the status bar's counters are worth another look. */
  activity(session: Session): void
}

/** What a heatmap view of the whole file at once has to offer the session. */
interface WholeFileView {
  readonly el: HTMLElement
  readonly sideEl: HTMLElement
  readonly panel: MatrixPanel
  applyScale(scale: ScaleState): void
  destroy(): void
}

export interface OpenFile {
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

/**
 * The annotation machinery for one open file.
 *
 * Bundled because the four pieces have exactly one lifetime between them: the
 * file. Opening another replaces all four, and closing one destroys all four.
 */
interface FileAnnotations {
  store: AnnotationStore
  manual: ManualStore
  client: AnnotationClient
  loader: AnnotationLoader
  contigLength(name: string): number | undefined
}

let nextSessionId = 1

/** Reserve the ids a restore is about to hand out, so a new tab cannot reuse one. */
export function reserveSessionIds(highest: number): void {
  nextSessionId = Math.max(nextSessionId, highest + 1)
}

export class Session {
  /** Stable within the page; what the tab strip and the session memory key on. */
  readonly id: string
  /** The mounted view lives here; the shell parents this into the content area. */
  readonly contentEl = el('div', { class: 'session-content' })
  readonly breadcrumbHost = el('div', { class: 'breadcrumb-host' })
  /** The three columns' bodies, filled here and re-parented by the shell. */
  readonly generalHost = el('div', { class: 'panel-host' })
  readonly annotationsHost = el('div', { class: 'panel-host' })
  readonly aestheticsHost = el('div', { class: 'panel-host' })
  readonly store = new ViewStore()

  /**
   * The reader worker, built on first use.
   *
   * Lazily, because a restored tab that nobody has clicked yet should cost no
   * worker and no h5wasm instance — that is the whole of what makes restoring
   * eight tabs cheaper than opening eight files.
   */
  private reader: ReaderClient | null = null
  private readonly picker: FilePicker

  private file: OpenFile | null = null
  private breadcrumb: Breadcrumb | null = null
  private infoPanel: InfoPanel | null = null
  /**
   * The whole-file view, kept across navigations, and the read it holds.
   *
   * The two views of the whole file at once — the metagenome's scan and the
   * cooler's single block — are the only ones the session holds rather than
   * rebuilds, for the one reason that justifies it: they are the expensive
   * reads. Leaving one for a genome and coming back has to return to the
   * picture and not to the gate, which is the promise `tableMemory` makes for a
   * filtered table at a thousandth of the price.
   *
   * The key is *what was read* (uri, level, balance): anything that changes it
   * is a different picture, so the view is rebuilt and the old one destroyed
   * rather than left holding a matrix nobody is looking at.
   */
  private wholeFile: { key: string; view: WholeFileView } | null = null
  private opening: string | null = null
  private current: {
    destroy?(): void
    applyScale?(scale: ScaleState): void
    /** Present on the heatmap views; the manual card places marks through it. */
    panel?: MatrixPanel
  } | null = null
  /**
   * Everything annotations need, for the file that is open (spec §8).
   *
   * Held by the session rather than by a view, because a view is rebuilt on
   * every navigation and ten loaded tracks must not be: leaving a region for the
   * contigs table and coming back has to return to the same picture. `null` on
   * a `.metacool`, which is the whole of §8.5's gate.
   */
  private annotations: FileAnnotations | null = null
  private manualCard: ManualCard | null = null
  /**
   * The state the mounted view was built for.
   *
   * Kept so `render` can tell a navigation from a repaint. `this.current` is the
   * view object; this is what it was built from.
   */
  private mounted: ViewState | null = null
  /** Memoised {@link stepTargets}, keyed on the state object's identity. */
  private stepCache: { state: ViewState; previous: string | null; next: string | null } | null = null
  private generalOn = false
  private annotationsOn = false
  private aestheticsOn = false
  private destroyed = false
  /**
   * This session holds a view state it has not acted on yet.
   *
   * The state of a tab that was restored and not clicked. It is a real state —
   * the tab is labelled from it and the address bar could be written from it —
   * and no byte of the file behind it has been read. Clicking is what reads it,
   * which is the whole of what makes remembering eight tabs cheap.
   */
  private primed = false
  /** Whether anything has ever been mounted here; see {@link activate}. */
  private painted = false

  constructor(private readonly host: SessionHost, id?: string) {
    this.id = id ?? `s${nextSessionId++}`
    this.picker = new FilePicker({
      onOpen: (uri, source) => void this.open(uri, source),
      examples: demoExamples(),
    })
    this.store.subscribe((state, change) => {
      this.host.stateChanged(this, change)
      void this.render(state)
    })
  }

  // -------------------------------------------------------------------------
  // What the shell asks about
  // -------------------------------------------------------------------------

  get state(): ViewState | null {
    return this.store.state
  }

  get hasFile(): boolean {
    return this.file !== null
  }

  /** `true` while this session names a file it has not opened. */
  get isPrimed(): boolean {
    return this.primed
  }

  /**
   * Adopt a view state without acting on it — a tab restored from a previous
   * visit, or a link that landed on a tab that is not the one on screen.
   */
  prime(state: ViewState): void {
    this.store.adopt(state)
    this.primed = true
    this.host.sessionChanged(this)
  }

  get isMetacool(): boolean {
    return this.file?.info.layout.kind === 'metacool'
  }

  /** The reader client, or `null` where nothing has ever been opened here. */
  get client(): ReaderClient | null {
    return this.reader
  }

  /** What the tab says. The file name, or the invitation that replaces it. */
  get label(): string {
    const state = this.store.state
    if (state !== null) return fileLabel(state.uri)
    return 'New session'
  }

  /** One line for the tab's tooltip: what it holds, or why it holds nothing. */
  get tabHint(): string {
    const state = this.store.state
    if (state === null) return 'Nothing open here yet — drop a file, or pick one from the list.'
    if (this.primed) {
      return inferSource(state.uri) === null
        ? `${state.uri} — a local file, remembered from an earlier visit. ` +
            'Click, then drop the same file again to follow it; the view will be restored.'
        : `${state.uri} — remembered, not yet read. Click to open it.`
    }
    return state.uri
  }

  /** Which of the three columns have anything to show for this session. */
  get panels(): { general: boolean; annotations: boolean; aesthetics: boolean } {
    return {
      general: this.generalOn,
      annotations: this.annotationsOn,
      aesthetics: this.aestheticsOn,
    }
  }

  /**
   * Bring this session on screen.
   *
   * For a session that has already been here, the DOM was never torn down — it
   * was only unparented — so this is a re-measure and nothing else: a canvas
   * keeps its pixels across a tab switch, which is what makes going back to a
   * map instant rather than a re-read.
   *
   * For a primed one it is the first read: a tab remembered from a previous
   * visit opens the moment it is clicked, and not before.
   *
   * And for a brand new one it is the first paint at all. A session with no
   * state never notified anybody — there was no transition to notify about —
   * so without this the picker would never be mounted and the page would come
   * up empty.
   */
  activate(): void {
    if (this.primed || !this.painted) {
      this.primed = false
      void this.render(this.store.state)
      return
    }
    this.current?.panel?.remeasure()
  }

  /** Re-measure whatever is mounted; a column moved or the window resized. */
  relayout(): void {
    this.current?.panel?.remeasure()
  }

  destroy(): void {
    this.destroyed = true
    this.current?.destroy?.()
    this.current = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.annotations?.client.destroy()
    this.annotations = null
    this.reader?.terminate()
    this.reader = null
  }

  // -------------------------------------------------------------------------
  // Commands this session can answer
  // -------------------------------------------------------------------------

  /**
   * The actions that are about *this file*, for the shell to merge with its own.
   *
   * Rebuilt on demand so `enabled` reflects the state the user is actually in;
   * the shell's own list is built the same way and for the same reason.
   */
  commands(): Command[] {
    const state = this.store.state
    const file = this.file
    const isMetacool = this.isMetacool
    return [
      {
        id: 'go-genomes',
        group: 'Go',
        title: 'Genomes table',
        keys: 'g',
        enabled: file !== null && isMetacool,
        run: () => {
          if (state !== null) this.store.set({ uri: state.uri, view: 'genomes' })
        },
      },
      {
        id: 'go-contigs',
        group: 'Go',
        title: 'Contigs table',
        keys: 'c',
        enabled: file !== null,
        run: () => {
          if (state !== null) this.store.set({ uri: state.uri, view: 'contigs' })
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
          : 'One bounded read. It asks first when the block is large, and is refused if it would not fit this machine.',
        keys: 'w',
        enabled: file !== null,
        run: () => {
          if (state !== null) {
            this.store.set({ uri: state.uri, view: isMetacool ? 'overview' : 'whole' })
          }
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
    const both = this.stepTargets()
    return delta < 0 ? both.previous : both.next
  }

  /**
   * Both directions at once, memoised on the state they were computed for.
   *
   * `commands()` asks for each direction *twice* — once for the hint and once
   * for `enabled` — and in a region view each answer is a linear scan of every
   * contig name. That is four scans of 154,468 strings per call, for a pair of
   * answers that cannot change while the view state does not.
   */
  private stepTargets(): { previous: string | null; next: string | null } {
    const state = this.store.state
    if (state === null) return { previous: null, next: null }
    const cached = this.stepCache
    if (cached !== null && cached.state === state) return cached
    const pair = {
      state,
      previous: this.computeStepTarget(-1),
      next: this.computeStepTarget(1),
    }
    this.stepCache = pair
    return pair
  }

  /** The uncached neighbour lookup; {@link stepTargets} is the way in. */
  private computeStepTarget(delta: number): string | null {
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

  /** The worker, built the first time anything needs one. */
  private clientOf(): ReaderClient {
    this.reader ??= new ReaderClient()
    return this.reader
  }

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
  async open(uri: string, source: SourceSpec, carry?: ViewState): Promise<void> {
    if (this.opening === uri) return
    this.opening = uri
    this.showContent(loading(`Opening ${fileLabel(uri)}`))
    this.host.sessionChanged(this)
    try {
      const client = this.clientOf()
      const info = await client.request<'open'>({ kind: 'open', uri, source })
      const genomes = await client.request<'genomes'>({ kind: 'genomes' })
      if (this.destroyed) return
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
        onNavigate: (state) => this.store.set(state),
        onOpenFile: () => this.host.openFileDialog(this),
        onSelectEntry: (entry) =>
          void this.open(
            `${splitUri(uri).path}::${info.entryGroup || 'entries'}/${entry}`,
            source,
            this.carryAcrossEntries(`${splitUri(uri).path}::${info.entryGroup || 'entries'}/${entry}`),
          ),
      })
      this.infoPanel = new InfoPanel({ info })
      // Before the sidebar is mounted, so the cards are there on the first paint
      // rather than appearing a frame later.
      await this.setUpAnnotations(uri, info)
      if (this.destroyed) return
      this.setGeneral([this.infoPanel.el])
      this.host.activity(this)
      // Destroyed, not merely dropped: a scan of the *previous* file may still
      // be running, and the reference going away is not what stops it.
      this.wholeFile?.view.destroy()
      this.wholeFile = null

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
      this.host.sessionChanged(this)
    }
  }

  // -------------------------------------------------------------------------
  // Annotations (spec §8)
  // -------------------------------------------------------------------------

  /**
   * Build the annotation stores and cards for a newly opened file, or tear the
   * previous file's down.
   *
   * The gate is one line and it is §8.5's: a file with a genome layer gets
   * nothing — no cards, no worker, no listeners. The reason is not effort. A
   * metacool's axis is contigs from thousands of independently assembled
   * organisms, so a GTF or a bigWig keyed on contig names either coincides or
   * misleads, and drawing a gene model across a MAG boundary would assert a
   * coordinate system that does not exist.
   */
  private async setUpAnnotations(uri: string, info: OpenResult): Promise<void> {
    this.annotations?.client.destroy()
    this.annotations = null
    this.manualCard = null
    if (info.hasGenomes) {
      this.setAnnotations([])
      return
    }

    // The contigs table is what every annotation is matched against — by name,
    // for the §8.2 overlap report, and by length, so an aggregated axis knows
    // how long one cell is. It is read once per file and cached, so this is the
    // only place that pays for it.
    const contigs = await this.contigs().catch(() => null)
    const names = contigNames(contigs)
    const lengths = contigLengths(contigs)

    const scope = this.memoryKey(uri)
    const store = new AnnotationStore(scope)
    const manual = new ManualStore(scope)
    const client = new AnnotationClient()
    const loader = new AnnotationLoader(store, client, names)
    this.annotations = { store, manual, client, loader, contigLength: (name) => lengths.get(name) }

    const picker: MapPicker = {
      available: () => this.current?.panel !== undefined,
      start: (onPoint, onEnd) => {
        const panel = this.current?.panel
        // No plot to click on. The mode ends before it starts, which the card
        // reads as "put the button back" — the button was disabled anyway, so
        // this is the race where a view was torn down between the two.
        if (panel === undefined) {
          onEnd()
          return () => {}
        }
        return panel.armPicking(onPoint, onEnd)
      },
    }
    this.manualCard = new ManualCard({ store: manual, picker, fileLabel: fileLabel(uri) })

    // The demo map ships ten annotation files on its own assembly. Offering
    // them as one click is the difference between a viewer that demonstrably
    // works and one a reader has to assemble a test case for.
    const published = demoAnnotationsFor(uri)
    this.setAnnotations([
      new AnnotationCard({
        card: 'linear',
        store,
        loader,
        ...(published.length === 0
          ? {}
          : {
              demo: {
                label: `load the ${published.length} tracks published with this map`,
                hint:
                  'Gene models, coverage, peak calls and loop calls, all on this map’s own ' +
                  'assembly. They open the same way any remote file does.',
                run: () => {
                  for (const entry of published) {
                    loader.addUrl(entry.card, entry.zone, entry.url, entry.label)
                  }
                },
              },
            }),
      }).el,
      new AnnotationCard({ card: 'overlay', store, loader }).el,
      this.manualCard.el,
    ])

    // What a previous visit to this file left in session storage (§8.6). After
    // the cards are mounted, so the restored rows land in a list that exists.
    loader.restore(AnnotationStore.stored(scope))
  }

  /**
   * The key this session's per-file memory hangs on.
   *
   * The session id is in it, and has to be: two tabs on the same file are two
   * independent workspaces, and keying their tracks and filters on the URI alone
   * would make the second one adopt the first one's — which is exactly the
   * behaviour tabs exist to prevent.
   */
  private memoryKey(uri: string): string {
    return `${this.id}|${uri}`
  }

  /** The context a heatmap view hands to its panel, or `undefined`. */
  private annotationContext(): AnnotationContext | undefined {
    const held = this.annotations
    return held === null
      ? undefined
      : {
          store: held.store,
          manual: held.manual,
          client: held.client,
          contigLength: held.contigLength,
        }
  }

  /**
   * The view to reopen at another resolution — the same one, at the other one.
   *
   * Switching resolution in an `.mcool` is not opening a different file: it is
   * the same data at a different bin size, and being returned to the landing
   * table for it means finding your way back to a chromosome and a range by
   * hand every time you change zoom level. Every field of a view state means
   * the same thing at every resolution — names are names and coordinates are
   * base pairs — so all of them carry.
   *
   * All but the *clip*. `vmax` is in counts, and counts scale with the bin: a
   * ceiling tuned at 1 kb is a saturated black square at 16 kb, and a floor is
   * an empty one. Dropping it hands the new block back to the §7.1 auto range,
   * which is the number the CLI would have picked for it.
   */
  private carryAcrossEntries(uri: string): ViewState | undefined {
    const state = this.store.state
    if (state === null) return undefined
    const { vmin: _vmin, vmax: _vmax, ...rest } = state
    return { ...rest, uri }
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
    const key = this.memoryKey(uri)
    return {
      initial: recall<TableUiState>(key, `table:${scope}`),
      save: (state) => remember(key, `table:${scope}`, state),
    }
  }

  private async contigs(): Promise<ContigsResult> {
    const file = this.file
    if (file === null) throw new Error('no file open')
    if (file.contigs === null) {
      file.contigs = await this.clientOf().request<'contigs'>({ kind: 'contigs' })
    }
    return file.contigs
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private async render(state: ViewState | null): Promise<void> {
    if (this.destroyed) return
    this.painted = true
    this.host.sessionChanged(this)

    if (state === null) {
      this.file = null
      this.mounted = null
      this.breadcrumb = null
      this.breadcrumbHost.replaceChildren()
      // The annotation worker belongs to the open file, and there is no longer
      // one. Its cache is megabytes of parsed features; leaving it running would
      // hold them until the tab closed.
      this.annotations?.client.destroy()
      this.annotations = null
      this.manualCard = null
      // For the same reason, and it is the one view the session holds: a cached
      // whole-file matrix is a picture of a file nobody can now navigate to,
      // and the scan that produced it may still be running.
      this.wholeFile?.view.destroy()
      this.wholeFile = null
      this.setGeneral([])
      // The cards described a file that is no longer open, and they hold the
      // stores that were just destroyed. Cleared with the column, so returning
      // to the picker does not leave three dropzones wired to nothing.
      this.setAnnotations([])
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
    if (state.balance === true && !this.file.info.hasWeights) {
      this.store.set({ ...state, balance: undefined }, { replace: true })
      return
    }

    if (state.view === 'genomes' && !this.file.info.hasGenomes) {
      this.store.set({ uri: state.uri, view: 'contigs' }, { replace: true })
      return
    }

    // The same rewrite for the other view a cooler cannot answer. `overview`
    // scans for a genome × genome matrix, and a file with no genome layer has
    // none — but it does have the other half of the same menu entry, the whole
    // map in one bounded read, which is what "Whole genome" means there.
    if (state.view === 'overview' && !this.file.info.hasGenomes) {
      this.store.set({ uri: state.uri, view: 'whole' }, { replace: true })
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
    if (
      this.mounted !== null &&
      this.current !== null &&
      differsOnlyInScale(this.mounted, state)
    ) {
      this.current.applyScale?.(this.scaleOf(state))
      this.mounted = state
      this.breadcrumb?.render(state)
      this.host.activity(this)
      return
    }

    this.breadcrumb?.render(state)
    this.breadcrumbHost.replaceChildren(this.breadcrumb?.el ?? el('div'))
    this.mounted = state

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
      case 'overview':
        this.mountOverview(state)
        break
      case 'selection':
        await this.mountSelection(state)
        break
    }
    // After the switch, not before: a region view reads the contigs table on the
    // way in, and there is no row to show until it has arrived.
    this.infoPanel?.setRecords(this.recordsFor(state))
    this.host.activity(this)
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
      onOpenSelection: (names) =>
        this.store.set({ uri: state.uri, view: 'selection', genomes: names.join(',') }),
      onOpenWhole: () => this.store.set({ uri: state.uri, view: this.wholeFileView() }),
    })
    this.showContent(view.el, view)
  }

  /**
   * Which of the two whole-file views this file has: the metagenome's scan, or
   * the cooler's single map. Both are called "Whole genome" wherever they are
   * offered, because they answer the same question by the means the file allows.
   */
  private wholeFileView(): 'overview' | 'whole' {
    return this.isMetacool ? 'overview' : 'whole'
  }

  private async mountContigs(state: ViewState): Promise<void> {
    const file = this.file
    if (file === null) return
    const data = await this.contigs()
    if (this.destroyed || this.store.state !== state) return
    // A plain cooler is opened as itself: no genome layer, no genome_id column,
    // and the chrom table is the landing view rather than a consolation prize.
    const cooler = !file.info.hasGenomes
    const view = new ContigsTable({
      data,
      hideColumns: cooler ? ['genome_id'] : [],
      title: cooler ? 'Chromosomes' : 'Contigs',
      hint: cooler
        ? 'One genome, its chromosomes. Pick one to see its map, or select a subset to compare them.'
        : undefined,
      persistence: this.tableMemory(state.uri, 'contigs'),
      onOpenContig: (contig) =>
        this.store.set({ uri: state.uri, view: 'region', region: contig, genome: state.genome }),
      // Neither while this table is one genome's contigs: "the whole file" is
      // not the question someone reading a MAG's contigs is asking, and the map
      // of *those* contigs is the genome view one crumb up.
      ...(state.genome === undefined
        ? {
            onOpenWhole: () => this.store.set({ uri: state.uri, view: this.wholeFileView() }),
            onOpenSelection: (names: string[]) =>
              this.store.set({ uri: state.uri, view: 'selection', regions: names.join(',') }),
          }
        : {}),
    })
    this.showContent(view.el, view)
  }

  private mountWhole(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const level = matrixLevel(state)
    const balance = this.balanceOf(state)
    this.mountWholeFile(
      state,
      `whole|${state.uri}|${level}|${String(balance)}`,
      () =>
        new WholeView({
          client: this.clientOf(),
          caption: this.captionFor(state),
          binsize: file.info.binsize ?? 1,
          nBins: file.info.nBins,
          // The file's own count of stored pixels, which is what the read walks.
          // A cooler that does not declare it is not gated rather than gated on
          // a guess; the same number is in the File card, from the same place.
          nnz: numberOr(file.info.info['nnz']),
          level,
          scale: this.scaleOf(state),
          balance,
          hasWeights: file.info.hasWeights,
          // Offered for a cooler too, now that the roll-up accumulates from the
          // stored pixels: a chromosome-level whole-genome view of yeast is
          // 17 x 17 cells and always fits, which makes it the honest answer when
          // the bin-level block does not. It is only meaningless on a file with
          // one sequence, where every level is a single cell.
          offerLevel: file.info.nContigs > 1,
          noun: file.info.hasGenomes ? 'contig' : 'chromosome',
          ...(this.annotationContext() === undefined
            ? {}
            : { annotations: this.annotationContext() }),
          // The two are mutually exclusive in practice and both are passed
          // anyway: a file either has a genome layer to name in the tooltip
          // (§7.4) or is a cooler that can carry annotations (§8.5), never both.
          namesGenomes: file.info.hasGenomes,
          onLevelChange: (next) => this.store.patch({ level: next }, { replace: true }),
          onBalanceChange: (next) => this.setBalance(next),
          onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
          onOpenRegion: (region, region2) =>
            this.store.set({
              uri: state.uri,
              view: 'region',
              region,
              ...(region2 === undefined ? {} : { region2 }),
            }),
          onError: (err) => this.showError(err),
        }),
    )
  }

  /**
   * The map of several chosen sequences (§5.5's plural).
   *
   * The same view as the whole-file one, told to draw less: see
   * {@link WholeView}. It is *not* held in {@link wholeFile}, because that slot
   * is keyed on one read and a reader ticking their way through a table would
   * evict it on every change — the whole-file map they were building on is
   * exactly what should survive.
   */
  private async mountSelection(state: ViewState): Promise<void> {
    const file = this.file
    if (file === null) return
    const selection = selectionOf(state)
    if (selection === null) {
      this.store.set({ uri: state.uri, view: this.wholeFileView() }, { replace: true })
      return
    }
    // A contig selection is measured against the contigs table, and a pasted
    // link arrives before anyone has opened one. Read it first: the alternative
    // is a selection whose size is unknown, which is a resolution chosen for a
    // picture nobody has measured. Cached after the first region view, so this
    // costs a read once per file.
    if (selection.kind === 'contig' && this.file?.contigs == null) {
      await this.contigs().catch(() => null)
      if (this.destroyed || this.store.state !== state) return
    }
    const bins = this.binsOfSelection(selection)
    const view = new WholeView({
      client: this.clientOf(),
      caption: this.captionFor(state),
      binsize: file.info.binsize ?? 1,
      nBins: file.info.nBins,
      nnz: numberOr(file.info.info['nnz']),
      level: 'bin',
      scale: this.scaleOf(state),
      balance: this.balanceOf(state),
      hasWeights: file.info.hasWeights,
      // No level toggle: the roll-up reads a bin range, and a selection is not
      // one. The sequences are already the axis at bin level here.
      offerLevel: false,
      noun: file.info.hasGenomes ? 'contig' : 'chromosome',
      ...(this.annotationContext() === undefined
        ? {}
        : { annotations: this.annotationContext() }),
      namesGenomes: file.info.hasGenomes,
      selection: { ...selection, bins },
      onLevelChange: () => {},
      onBalanceChange: (next) => this.setBalance(next),
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

  /**
   * How many bins a selection covers — what its pooling stride is measured
   * against, so four MAGs are drawn at four MAGs' resolution and not the
   * file's.
   *
   * From the tables already in memory: `/genomes` carries `n_bins`, and a
   * contig's bins are its length over the bin size. Names that match nothing
   * count nothing, which is also how the worker reads them.
   */
  private binsOfSelection(selection: UnitSelection): number {
    const file = this.file
    if (file === null) return 0
    if (selection.kind === 'genome') {
      const names = file.genomes.table.data['name']
      const counts = file.genomes.table.data['n_bins']
      if (!Array.isArray(names) || counts === undefined || Array.isArray(counts)) return 0
      let bins = 0
      for (const name of selection.names) {
        const row = (names as string[]).indexOf(name)
        if (row >= 0) bins += Number(counts[row])
      }
      return bins
    }
    const binsize = file.info.binsize ?? 1
    const lengths = contigLengths(file.contigs)
    let bins = 0
    for (const name of selection.names) {
      const length = lengths.get(name)
      if (length !== undefined) bins += Math.ceil(length / binsize)
    }
    return bins
  }

  private mountGenome(state: ViewState): void {
    if (state.genome === undefined) {
      this.store.set({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const view = new GenomeView({
      client: this.clientOf(),
      caption: this.captionFor(state),
      binsize: this.file?.info.binsize ?? 1,
      genome: state.genome,
      balance: this.balanceOf(state),
      hasWeights: this.file?.info.hasWeights === true,
      onBalanceChange: (balance) => this.setBalance(balance),
      neighbours: { prev: this.stepTarget(-1), next: this.stepTarget(1) },
      onStep: (delta) => this.step(delta),
      level: matrixLevel(state),
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
      client: this.clientOf(),
      caption: this.captionFor(state),
      binsize: file.info.binsize ?? 1,
      genomeNames: file.displayNames,
      balance: this.balanceOf(state),
      hasWeights: file.info.hasWeights,
      onBalanceChange: (balance) => this.setBalance(balance),
      rowGenome: state.genome,
      colGenome: state.genome2,
      level: matrixLevel(state),
      scale: this.scaleOf(state),
      onChangeGenomes: (genome, genome2) => this.store.set({ ...state, genome, genome2 }),
      onLevelChange: (level) => this.store.patch({ level }, { replace: true }),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenGenome: (genome) => this.store.set({ uri: state.uri, view: 'genome', genome }),
      onOpenContig: (region, region2) =>
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

  private async mountRegion(state: ViewState): Promise<void> {
    if (state.region === undefined) {
      this.store.set({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    // The contigs table is what "next contig" steps through. It is read once
    // per file and cached, so this costs a read on the first region view and
    // nothing afterwards.
    if (this.file?.contigs == null) await this.contigs().catch(() => null)
    if (this.destroyed || this.store.state !== state) return
    const view = new RegionView({
      client: this.clientOf(),
      caption: this.captionFor(state),
      binsize: this.file?.info.binsize ?? 1,
      region: state.region,
      noun: this.file?.info.hasGenomes === false ? 'chromosome' : 'contig',
      ...(this.annotationContext() === undefined ? {} : { annotations: this.annotationContext() }),
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
      onChangeRegion: (region, region2) => {
        const { region2: _dropped, ...rest } = state
        this.store.set({ ...rest, region, ...(region2 === undefined ? {} : { region2 }) })
      },
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenGenome: (genome) => this.store.set({ uri: state.uri, view: 'genome', genome }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  /** The whole-metagenome scan (§7.3), mounted like any other view. */
  private mountOverview(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const level = overviewLevel(state)
    this.mountWholeFile(
      state,
      `overview|${state.uri}|${level}`,
      () =>
        new Overview({
          client: this.clientOf(),
          caption: this.captionFor(state),
          binsize: file.info.binsize ?? 1,
          sourceKind: file.info.sourceKind,
          sourceBytes: file.info.sourceBytes,
          // A query parameter rather than view state: it describes where the
          // file is published, not which picture of it is on screen.
          edgeListUrl: new URLSearchParams(window.location.search).get('edges') ?? undefined,
          level,
          scale: this.scaleOf(state),
          onLevelChange: (next) => this.store.patch({ level: next }, { replace: true }),
          onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
          onOpenPair: (a, b) =>
            this.store.set({ uri: file.uri, view: 'pair', genome: a, genome2: b }),
          onOpenGenome: (genome) => this.store.set({ uri: file.uri, view: 'genome', genome }),
          onOpenContig: (region, region2) =>
            this.store.set({
              uri: file.uri,
              view: 'region',
              region,
              ...(region2 === undefined ? {} : { region2 }),
            }),
          onError: (err) => this.showError(err),
        }),
    )
  }

  /**
   * Mount the view of the whole file, building it only if this is not the one
   * already in hand — see {@link wholeFile} for what "the one" means.
   *
   * What goes to {@link showContent} is a *handle* rather than the view: it
   * carries what the session needs from anything mounted, the controls column
   * and the panel to re-measure, and deliberately no `destroy`. That is the
   * whole of the caching — navigating away releases the DOM and keeps the
   * matrix — and it is why the destroy at the top of this function is written
   * out: it is the only one that ever runs for these two views.
   *
   * The scale is applied on every mount because the URL is the truth and it may
   * have moved while this view was not on screen: change the transform in a
   * genome view and come back, and the map is drawn the way the hash says.
   */
  private mountWholeFile(state: ViewState, key: string, build: () => WholeFileView): void {
    if (this.wholeFile !== null && this.wholeFile.key !== key) {
      this.wholeFile.view.destroy()
      this.wholeFile = null
    }
    this.wholeFile ??= { key, view: build() }
    const { view } = this.wholeFile
    view.applyScale(this.scaleOf(state))
    this.showContent(view.el, {
      sideEl: view.sideEl,
      panel: view.panel,
      applyScale: (scale) => view.applyScale(scale),
    })
  }

  // -------------------------------------------------------------------------
  // Mounting
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
  toPicker(): void {
    if (this.store.state === null) void this.render(null)
    else this.store.set(null)
  }

  private showContent(
    node: HTMLElement,
    view?: {
      destroy?(): void
      applyScale?(scale: ScaleState): void
      sideEl?: HTMLElement
      panel?: MatrixPanel
    },
  ): void {
    this.current?.destroy?.()
    this.current = view ?? null
    // "Click the map" is only offered while there is a map. A table view has
    // none, and a button that arms a gesture nothing can complete is worse than
    // one that is plainly unavailable.
    this.manualCard?.refresh()
    this.contentEl.replaceChildren(node)
    // Emptied rather than hidden when a view has no controls: a table view
    // offers no aesthetics, so the column leaves the layout and its button goes
    // with it — the same rule the other two follow.
    this.setAesthetics(view?.sideEl === undefined ? [] : [view.sideEl])
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

  private setGeneral(nodes: readonly HTMLElement[]): void {
    this.generalHost.replaceChildren(...nodes)
    this.setAvailability('general', nodes.length > 0)
  }

  private setAnnotations(nodes: readonly HTMLElement[]): void {
    this.annotationsHost.replaceChildren(...nodes)
    this.setAvailability('annotations', nodes.length > 0)
  }

  private setAesthetics(nodes: readonly HTMLElement[]): void {
    this.aestheticsHost.replaceChildren(...nodes)
    this.setAvailability('aesthetics', nodes.length > 0)
  }

  private setAvailability(which: 'general' | 'annotations' | 'aesthetics', on: boolean): void {
    const field = which === 'general' ? 'generalOn' : which === 'annotations' ? 'annotationsOn' : 'aestheticsOn'
    if (this[field] === on) return
    this[field] = on
    this.host.panelsChanged(this)
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
export function loading(message: string): HTMLElement {
  return el(
    'div',
    { class: 'loading' },
    el('div', { class: 'spinner', attrs: { role: 'progressbar', 'aria-label': message } }),
    el('p', { class: 'loading-text', text: `${message}…` }),
  )
}

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

/**
 * A number out of a file attribute, or `null`.
 *
 * `info` is whatever the file's root attributes said, so an entry may be absent,
 * `null`, a string, or a `BigInt` an int64 attribute arrived as. Anything that
 * is not a finite number is "the file did not say", which is a different answer
 * from zero and has to stay one.
 */
function numberOr(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Colour-scale fields carried by a view state (§5.5), over the file's defaults.
 *
 * Only the transform has a per-file default, and only one file has it: see
 * `Session.balancedByDefault`. Everything else absent means the §7.1 default,
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
export function inferSource(uri: string): SourceSpec | null {
  const { path } = splitUri(uri)
  return /^https?:\/\//i.test(path) ? { kind: 'remote', url: path } : null
}

/** Contig names from the contigs table, or `[]` if it could not be read. */
function contigNames(contigs: ContigsResult | null): string[] {
  const column = contigs?.table.data['name']
  return Array.isArray(column) ? (column as string[]) : []
}

/**
 * Contig lengths by name.
 *
 * A `Map` rather than a pair of parallel arrays because every consumer looks up
 * by name — an annotation file knows what it calls a contig and nothing about
 * the row it sits on.
 */
function contigLengths(contigs: ContigsResult | null): Map<string, number> {
  const out = new Map<string, number>()
  const names = contigNames(contigs)
  const lengths = contigs?.table.data['length']
  if (names.length === 0 || lengths === undefined || Array.isArray(lengths)) return out
  for (let i = 0; i < names.length; i++) out.set(names[i], Number(lengths[i]))
  return out
}
