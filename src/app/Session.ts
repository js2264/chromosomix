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
import type { WireSource } from '../annotations/worker/protocol'
import { assemblyOf, lengthsAreExact, type Assembly } from '../genome/assembly'
import { AnnotationCard } from '../ui/AnnotationCard'
import { Breadcrumb } from '../ui/Breadcrumb'
import { BrowserView, type GroupMode } from '../ui/BrowserView'
import { CompareCard, compareRefusal } from '../ui/CompareCard'
import type { CompareRead } from '../ui/compare'
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
import { button, el, fmt } from '../ui/dom'
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
 * How to reach a file's bytes, in the shape the annotations worker takes.
 *
 * The reader's `SourceSpec` and the annotations worker's `WireSource` are the
 * same two cases under two names — a `File` handed over by reference, or a URL —
 * and the one place they meet is a file whose *kind* is not yet known.
 */
function toWire(source: SourceSpec): WireSource {
  return source.kind === 'local'
    ? { kind: 'local', file: source.file, name: source.file.name }
    : { kind: 'remote', url: source.url, name: source.url.split('/').pop() ?? source.url }
}

/**
 * The General column of a browser session: what genome this is, and where its
 * lengths came from.
 *
 * Shorter than a map's File card because there is less to say and every line of
 * it matters: a reader who opened a browser from a peak set needs to know the
 * sequence ends are a lower bound, and a reader who opened one from a bigWig
 * needs to know they are not.
 */
function genomeCard(assembly: Assembly, onOpenFile: () => void): HTMLElement {
  const exact = lengthsAreExact(assembly)
  const rows: Array<[string, string]> = [
    ['uri', assembly.uri],
    ['sequences', fmt.int(assembly.contigs.length)],
    ['total', `${fmt.bp(assembly.total)}${exact ? '' : ' (at least)'}`],
    ['lengths', ORIGINS[assembly.origin]],
  ]
  return el(
    'aside',
    { class: 'info-panel' },
    el(
      'div',
      { class: 'card' },
      el('h3', { text: 'Genome' }),
      el(
        'div',
        { class: 'kv' },
        ...rows.flatMap(([key, value]) => [
          el('div', { class: 'k', text: key }),
          el('div', { class: 'v', text: value, title: value }),
        ]),
      ),
      ...(exact
        ? []
        : [
            el('p', {
              class: 'hint',
              text:
                'This file carries no sequence lengths, so each one ends at its last feature ' +
                'rounded up. Drop a chrom.sizes or a bigWig to replace them with the real ones.',
            }),
          ]),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', { text: 'Contact map' }),
      el('p', {
        class: 'hint',
        text:
          'Drop a .cool or .mcool anywhere on the tracks to switch this session to its map. The ' +
          'tracks come with it.',
      }),
      button('open a file…', onOpenFile, { class: 'btn btn-wide' }),
    ),
  )
}

/** How each kind of source is described in the Genome card. */
const ORIGINS: Record<Assembly['origin'], string> = {
  sizes: 'declared by a chrom.sizes',
  bigwig: 'from the bigWig header',
  bigbed: 'from the bigBed header',
  features: 'inferred from the features',
  cooler: 'from the cooler’s /chroms',
}

/** The second file of a comparison, and what the gate had to read to accept it. */
interface OpenCompare {
  uri: string
  source: SourceSpec
  client: ReaderClient
  info: OpenResult
  /** Name and length per chromosome, in file order — what the gate compared. */
  contigs: Array<[string, number]>
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
    /** Present on the genome browser, which owns a canvas of its own. */
    remeasure?(): void
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
  /**
   * The second file, drawn in the lower-left triangle (`render/compare.ts`).
   *
   * A whole open file, with a reader of its own: the same shape as
   * {@link file}'s, minus everything only the *first* file answers — no genomes
   * table, no annotations, no record card. That asymmetry is the feature rather
   * than a shortcut. The comparison is one map with two sets of numbers in it,
   * not two browsers side by side, so exactly one file decides what the axes
   * are, what the tracks are drawn against, and what the breadcrumb says.
   */
  private compare: OpenCompare | null = null
  private compareCard: CompareCard | null = null
  /** The URI a compare open is in flight for, so a re-render does not restart it. */
  private compareOpening: string | null = null
  /**
   * The genome this session is browsing, when there is no contact map.
   *
   * A session is in one of two shapes and this is the discriminant: with a
   * {@link file} it is a map browser with tracks beside the map, with an
   * assembly it is a 1D genome browser with the same tracks and no map. Both at
   * once never happens — opening a map from a browser replaces the assembly with
   * the map's own chromosomes, and closing a map falls back to exactly that.
   */
  private assembly: Assembly | null = null
  private browser: BrowserView | null = null
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

  /** `true` while this session is a 1D genome browser rather than a map. */
  get isBrowsing(): boolean {
    return this.assembly !== null
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
    this.relayout()
  }

  /** Re-measure whatever is mounted; a column moved or the window resized. */
  relayout(): void {
    this.current?.panel?.remeasure()
    this.current?.remeasure?.()
  }

  destroy(): void {
    this.destroyed = true
    this.current?.destroy?.()
    this.current = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.annotations?.client.destroy()
    this.annotations = null
    this.compare?.client.terminate()
    this.compare = null
    this.assembly = null
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
    // A browser session answers a different set: there is no genomes table and
    // no whole-metagenome scan, and the two things it *does* have — a locus and
    // a zoom — have no counterpart on a map. Listing a map's actions beside a
    // browser (greyed out, every one of them) would be a palette that mostly
    // says no.
    if (this.assembly !== null) {
      return [
        {
          id: 'browser-whole',
          group: 'Go',
          title: 'The whole genome',
          hint: 'Every sequence, end to end. Also the 0 key, and a double click on the tracks.',
          keys: 'w',
          run: () => this.store.patch({ locus: undefined }),
        },
        {
          id: 'browser-locus',
          group: 'Go',
          title: 'Go to a locus',
          hint: 'chrI:1,000-20,000, a sequence name, or a gene from the search box.',
          keys: 'l',
          run: () => this.browser?.focusLocus(),
        },
        {
          id: 'browser-search',
          group: 'Go',
          title: 'Find a gene or feature',
          hint: 'Searches the names in every loaded gene model and peak set.',
          keys: '/',
          run: () => this.browser?.focusSearch(),
        },
        {
          id: 'browser-map',
          group: 'File',
          title: 'Open a contact map on this genome',
          hint: 'Or drop a .cool anywhere on the tracks; the tracks come with it.',
          run: () => this.host.openFileDialog(this),
        },
      ]
    }
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
   * Which of the two things a file is, decided by its name.
   *
   * A guess, and it only has to be right about the *common* cases, because the
   * one it is wrong about costs a wasted open and is then corrected by the bytes
   * — {@link openUnknown} asks the annotations worker what the file actually is
   * and re-routes. Guessing first is what keeps a `.cool` from paying for a
   * second worker and a second read on every open.
   */
  private routeOf(uri: string): 'map' | 'genome' | 'unknown' {
    const name = splitUri(uri).path.split(/[\\/]/).pop() ?? uri
    if (/\.(m?cool|m?metacool|h5|hdf5)$/i.test(name)) return 'map'
    if (
      /\.(bw|bigwig|bb|bigbed|chrom\.sizes|sizes|genome|fai|gtf|gff3?|bed|bedpe|narrowPeak|broadPeak|gappedPeak)(\.gz)?$/i.test(
        name,
      )
    ) {
      return 'genome'
    }
    return 'unknown'
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
    // A file that is not a contact map starts a genome browser instead. Decided
    // by name first, and by the bytes when the name does not say — see
    // {@link routeOf}.
    const route = this.routeOf(uri)
    if (route === 'genome') {
      await this.openGenome(uri, source, carry?.locus)
      return
    }
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
      // A map and a genome are the two shapes of a session and never both: a
      // `.cool` dropped on the browser is a map from here on, and leaving the
      // assembly set would keep the browser's command list and its panels.
      this.assembly = null
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
      this.infoPanel = new InfoPanel({
        info,
        onCloseFile: (which) => this.closeCompare(which),
        // With one file open there is nothing to close it *for* — except the
        // genome underneath it, which a cooler carries and which the tracks
        // beside the map are already drawn against.
        onCloseMap: () => this.closeMap(),
      })
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
      // `view=browser` is the one view a map session cannot hold: it names the
      // *other* shape of session, and carrying it here would leave the store
      // saying "browser" over an open matrix — which the router then answers by
      // trying to open the genome again. Closing the map is what produces that
      // state, and it does so deliberately (see `closeMap`).
      const target =
        wanted !== null && wanted.uri === uri && wanted.view !== 'browser'
          ? wanted
          : landingState(uri, rootView)
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
      // The name said nothing and the reader could not open it. Ask what it
      // actually is before reporting a failure: a bigWig with no suffix, or a
      // `chrom.sizes` called `yeast.txt`, is a perfectly good genome to browse
      // and only looks like a broken cooler from here.
      // Cleared *before* the attempt, not after: `openGenome` refuses to open a
      // URI that is already opening, which this one is — the guard belongs to
      // the read that just failed. The two other redirects out of this catch
      // clear it for the same reason.
      this.opening = null
      if (route === 'unknown' && (await this.openUnknown(uri, source, carry))) return
      this.showError(err, uri, source)
    } finally {
      this.opening = null
      this.host.sessionChanged(this)
    }
  }

  /**
   * Second-guess a file the reader refused, by its bytes.
   *
   * Returns `true` when it turned out to be a genome and a browser was opened
   * for it. The annotations worker is the only thing that looks at bytes before
   * anything has committed to what they are, which is exactly the question here.
   */
  private async openUnknown(
    uri: string,
    source: SourceSpec,
    carry?: ViewState,
  ): Promise<boolean> {
    try {
      const client = new AnnotationClient()
      const result = await client.request<'assembly'>({ kind: 'assembly', source: toWire(source) })
      client.destroy()
      if (result.format === null || result.format === 'hdf5' || result.contigs.length === 0) {
        return false
      }
    } catch {
      return false
    }
    if (this.destroyed) return false
    await this.openGenome(uri, source, carry?.locus)
    return true
  }

  // -------------------------------------------------------------------------
  // The 1D genome browser
  // -------------------------------------------------------------------------

  /**
   * Start a browser on the genome a file declares, and load that file as its
   * first track.
   *
   * The file is asked what genome it is on before anything else happens, because
   * that answer is what makes the browser possible at all: a bigWig's header
   * carries every sequence and its length, a `chrom.sizes` is nothing but that
   * list, and a feature file at least says how far along each sequence it
   * reaches. Only then is it loaded as a track — through the ordinary loader, so
   * a bigWig dropped here and a bigWig dropped beside a map are the same row
   * with the same settings and the same session memory.
   */
  private async openGenome(
    uri: string,
    source: SourceSpec,
    locus?: string,
    /**
     * The caller asked for a browser *by name* — a `view=browser` link, or a
     * fallback from closing a map. A contact map then means "browse the genome
     * under it", which is what closing one already does; without this a shared
     * `view=browser` link to a cooler silently opened the map instead.
     */
    insist = false,
  ): Promise<void> {
    if (this.opening === uri) return
    this.opening = uri
    this.showContent(loading(`Reading ${fileLabel(uri)}`))
    this.host.sessionChanged(this)
    const client = new AnnotationClient()
    try {
      const result = await client.request<'assembly'>({ kind: 'assembly', source: toWire(source) })
      if (this.destroyed) {
        client.destroy()
        return
      }
      if (result.format === 'hdf5') {
        // Named a genome, turned out to be a contact map. Hand it to the reader
        // rather than refusing: what the user did was drop a file, and this is
        // the same file either way — unless a browser was asked for by name, in
        // which case the map is opened for its `/chroms` and immediately closed,
        // which is exactly the fallback the File card's close button performs.
        client.destroy()
        this.opening = null
        await this.open(uri, source)
        if (insist && !this.destroyed && this.file !== null) {
          await this.contigs().catch(() => null)
          if (!this.destroyed) this.closeMap()
        }
        return
      }
      if (result.contigs.length === 0) {
        throw new Error(
          'This file names no sequences, so there is no genome to browse. A chrom.sizes, a ' +
            'bigWig or a bigBed declares one outright; a BED or a GTF declares one by mentioning ' +
            'coordinates on it.',
        )
      }
      client.destroy()
      const assembly = assemblyOf({
        uri,
        name: fileLabel(uri),
        contigs: result.contigs,
        origin: result.origin,
      })
      this.tearDown()
      this.assembly = assembly
      this.setUpBrowserAnnotations(assembly)
      // The file that named the genome is also its first track — unless it was a
      // `chrom.sizes`, which declares an assembly and draws nothing.
      if (result.format !== 'sizes' && this.annotations !== null) {
        const card = result.format === 'bedpe' ? 'overlay' : 'linear'
        const zone =
          result.format === 'gtf'
            ? 'gtf'
            : result.format === 'bigwig'
            ? 'track'
            : result.format === 'bedpe'
            ? 'pairs'
            : 'segments'
        if (source.kind === 'local') this.annotations.loader.addFiles(card, zone, [source.file])
        else this.annotations.loader.addUrl(card, zone, source.url)
      }
      const target: ViewState = {
        uri,
        view: 'browser',
        ...(locus === undefined ? {} : { locus }),
      }
      const willNotify = !viewStateEquals(target, this.store.state)
      this.store.set(target, { replace: true })
      if (!willNotify) void this.render(target)
    } catch (err) {
      client.destroy()
      if (!this.destroyed) this.showError(err, uri, source)
    } finally {
      this.opening = null
      this.host.sessionChanged(this)
    }
  }

  /**
   * The annotation machinery for a browser session.
   *
   * The same four pieces a map gets, against the assembly rather than against a
   * contigs table — which is the only difference, and it is one lookup: the
   * §8.2 overlap report and the per-contig lengths both come from the assembly's
   * own list. A track therefore behaves identically in both, and a session that
   * later opens a map keeps nothing from here, because the map has its own.
   */
  private setUpBrowserAnnotations(assembly: Assembly): void {
    const scope = this.memoryKey(assembly.uri)
    const store = new AnnotationStore(scope)
    const manual = new ManualStore(scope)
    const client = new AnnotationClient()
    const names = assembly.contigs.map((contig) => contig.name)
    const lengths = new Map(assembly.contigs.map((contig) => [contig.name, contig.length]))
    const loader = new AnnotationLoader(store, client, names)
    this.annotations = { store, manual, client, loader, contigLength: (name) => lengths.get(name) }

    this.setAnnotations([
      new AnnotationCard({ card: 'linear', store, loader, context: 'browser' }).el,
      new AnnotationCard({ card: 'overlay', store, loader, context: 'browser' }).el,
    ])
    this.setGeneral([genomeCard(assembly, () => this.host.openFileDialog(this))])
    loader.restore(AnnotationStore.stored(scope))
  }

  private mountBrowser(state: ViewState): void {
    const assembly = this.assembly
    const held = this.annotations
    if (assembly === null || held === null) return
    const key = this.memoryKey(assembly.uri)
    const view = new BrowserView({
      assembly,
      store: held.store,
      client: held.client,
      ...(state.locus === undefined ? {} : { locus: state.locus }),
      onLocusChange: (locus) => this.store.patch({ locus }, { replace: true }),
      memory: {
        groups: recall<Record<string, GroupMode>>(key, 'browser:groups') ?? {},
        save: (groups) => remember(key, 'browser:groups', groups),
      },
      onDropFile: (file) => this.dropped(file),
    })
    this.browser = view
    this.showContent(view.el, {
      destroy: () => {
        // Only if it is still this one. `showContent` destroys what was mounted
        // *after* the replacement has been built, so a remount would otherwise
        // have the outgoing view's teardown null the incoming one.
        if (this.browser === view) this.browser = null
        view.destroy()
      },
      sideEl: view.sideEl,
      remeasure: () => view.remeasure(),
    })
  }

  /**
   * A file dropped on the browser.
   *
   * A track joins the stack; anything else is opened as a file, which is what
   * turns a dropped `.cool` into a heatmap in the tab you were already in. The
   * decision is by name, exactly as {@link routeOf} makes it everywhere else —
   * and a file whose name says nothing is offered to the loader, which reads its
   * bytes and refuses it by name if it is not an annotation.
   */
  private dropped(file: File): void {
    if (this.routeOf(file.name) === 'map') {
      void this.open(file.name, { kind: 'local', file })
      return
    }
    // A sizes file dropped on a browser is not a track — it is an answer to the
    // question the browser is asking when its lengths were inferred. It replaces
    // them and keeps everything else, tracks included.
    if (this.assembly !== null && /\.(chrom\.sizes|sizes|genome|fai)$/i.test(file.name)) {
      void this.adoptSizes(file)
      return
    }
    const held = this.annotations
    if (held === null) return
    const card = /\.bedpe$/i.test(file.name) ? 'overlay' : 'linear'
    const zone = /\.(bw|bigwig)$/i.test(file.name)
      ? 'track'
      : /\.(gtf|gff3?)(\.gz)?$/i.test(file.name)
      ? 'gtf'
      : /\.bedpe$/i.test(file.name)
      ? 'pairs'
      : 'segments'
    held.loader.addFiles(card, zone, [file])
  }

  /**
   * Take this browser's sequence lengths from a `chrom.sizes` instead.
   *
   * The case it exists for is a browser opened on a BED or a GTF, whose
   * sequences end at their last feature because that is all such a file knows.
   * Dropping the assembly's own sizes replaces the guesses with the lengths —
   * and replaces *only* those: the URI, the session memory and every loaded
   * track are what they were, because the genome did not change, only what is
   * known about it.
   */
  private async adoptSizes(file: File): Promise<void> {
    const assembly = this.assembly
    if (assembly === null) return
    const client = new AnnotationClient()
    try {
      const result = await client.request<'assembly'>({
        kind: 'assembly',
        source: { kind: 'local', file, name: file.name },
      })
      if (this.destroyed || this.assembly !== assembly) return
      if (result.format !== 'sizes' || result.contigs.length === 0) {
        // Named like a sizes file and is not one. Offer it to the loader, which
        // reads its bytes and refuses it by name if it is nothing at all.
        this.annotations?.loader.addFiles('linear', 'segments', [file])
        return
      }
      this.assembly = assemblyOf({
        uri: assembly.uri,
        name: assembly.name,
        contigs: result.contigs,
        origin: 'sizes',
      })
      this.setGeneral([genomeCard(this.assembly, () => this.host.openFileDialog(this))])
      const state = this.store.state
      if (state === null) return
      // Rebuilt rather than told: an assembly is what a `BrowserView` is a view
      // *of*, and its axis is built once from it.
      this.mounted = state
      this.mountBrowser(state)
    } catch (err) {
      if (!this.destroyed) this.showError(err)
    } finally {
      client.destroy()
    }
  }

  /**
   * Close the contact map and keep browsing its genome.
   *
   * A cooler carries a chromosome list, which is an assembly; there is no reason
   * for closing the map to also throw away the tracks that were drawn beside it.
   * So it does not — the same store, the same rows, the same colours, now along
   * a genome instead of along an axis of bins.
   */
  private closeMap(): void {
    const file = this.file
    if (file === null) return
    const contigs = contigPairs(file.contigs)
    if (contigs.length === 0) {
      this.toPicker()
      return
    }
    const assembly = assemblyOf({
      uri: file.uri,
      name: fileLabel(file.uri),
      contigs: contigs.map(([name, length]) => ({ name, length })),
      origin: 'cooler',
    })
    // The annotations survive: they are keyed on this session and this URI, and
    // both are exactly what they were. Only the *map* is being closed.
    const held = this.annotations
    // The mounted view first, and the reader after it: terminating a worker
    // rejects every read still in flight, and a view that is still mounted
    // answers that by putting an error screen where the browser is about to go.
    this.current?.destroy?.()
    this.current = null
    this.compare?.client.terminate()
    this.compare = null
    this.compareCard = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.file = null
    this.breadcrumb = null
    this.breadcrumbHost.replaceChildren()
    this.reader?.terminate()
    this.reader = null
    this.assembly = assembly
    if (held === null) this.setUpBrowserAnnotations(assembly)
    else {
      this.setAnnotations([
        new AnnotationCard({ card: 'linear', store: held.store, loader: held.loader, context: 'browser' }).el,
        new AnnotationCard({ card: 'overlay', store: held.store, loader: held.loader, context: 'browser' }).el,
      ])
      this.setGeneral([genomeCard(assembly, () => this.host.openFileDialog(this))])
    }
    this.mounted = null
    const target: ViewState = { uri: file.uri, view: 'browser' }
    // `set` is a no-op when the state is already exactly this — which it is when
    // a `view=browser` link to a cooler got here by opening the map for its
    // `/chroms` — so render explicitly in that case, and only in that case.
    const willNotify = !viewStateEquals(target, this.store.state)
    this.store.set(target)
    if (!willNotify) void this.render(target)
  }

  /** Everything a session holds for one file, released before it holds another. */
  private tearDown(): void {
    this.annotations?.client.destroy()
    this.annotations = null
    this.manualCard = null
    this.dropCompare()
    this.compareCard = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.file = null
    this.assembly = null
    this.breadcrumb = null
    this.breadcrumbHost.replaceChildren()
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
    // The comparison belonged to the file that is being replaced. Its worker
    // goes with it — the second map was a second map *of this one*, and there is
    // no sense in which it survives the first being closed.
    this.dropCompare()
    this.compareCard = null
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

    this.compareCard = new CompareCard({
      primaryLabel: () => fileLabel(this.file?.uri ?? uri),
      onOpen: (source) =>
        void this.openCompare(
          source.kind === 'local' ? source.file.name : source.url,
          source.kind === 'local'
            ? { kind: 'local', file: source.file }
            : { kind: 'remote', url: splitUri(source.url).path },
        ),
      onClose: () => this.closeCompare(2),
      onSwap: () => void this.swapCompare(),
    })

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
      this.compareCard.el,
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

  // -------------------------------------------------------------------------
  // The second file (`render/compare.ts`)
  // -------------------------------------------------------------------------

  /**
   * Open a second cooler into the lower-left triangle, or refuse it with the
   * reason.
   *
   * The gate is read *before* anything is drawn and it is three questions —
   * cooler, same bin size, same chromosomes — because each of the three is a way
   * the merged picture would be a lie rather than a limitation of the code. See
   * {@link compareRefusal}, which owns the wording.
   *
   * A refused file leaves nothing behind: its worker is put down here, so a
   * reader trying three files in a row does not accumulate three h5wasm
   * instances for the two that were wrong.
   */
  private async openCompare(uri: string, source: SourceSpec): Promise<void> {
    const file = this.file
    if (file === null || this.compareOpening === uri) return
    this.compareOpening = uri
    this.compareCard?.set({ kind: 'loading', label: fileLabel(uri) })
    const client = new ReaderClient()
    try {
      const info = await client.request<'open'>({ kind: 'open', uri, source })
      const contigs = await client.request<'contigs'>({ kind: 'contigs' })
      // The primary file may have been replaced while this one was opening — a
      // resolution picked from the breadcrumb is enough. The gate is about *two*
      // files, so it has to be the two it started with, or it would compare one
      // file's bin size against another file's contigs and pass.
      if (this.destroyed || this.file !== file) {
        client.terminate()
        return
      }
      const mine = await this.contigs()
      if (this.destroyed || this.file !== file) {
        client.terminate()
        return
      }
      const refusal = compareRefusal(file.info, info, {
        primary: contigPairs(mine),
        second: contigPairs(contigs),
      })
      if (refusal !== null) {
        client.terminate()
        this.compareCard?.set({ kind: 'error', label: fileLabel(uri), message: refusal })
        this.forget(uri)
        return
      }
      this.compare?.client.terminate()
      this.compare = { uri, source, client, info, contigs: contigPairs(contigs) }
      this.compareCard?.set({ kind: 'open', label: fileLabel(uri), info })
      this.infoPanel?.setCompare(info)
      // A remote second file survives being shared; a local one cannot be
      // reopened from a link any more than a local first file can (§11), so it
      // is deliberately kept out of the hash rather than written as a name
      // nobody's browser can act on.
      if (inferSource(uri) !== null) this.store.patch({ uri2: uri })
      this.remount()
    } catch (err) {
      client.terminate()
      if (this.destroyed) return
      // A collection addressed at its root is a `KeyError` in Python and the
      // reader mirrors it faithfully (§3.4) — but somebody who dropped an
      // `.mcool` on the compare card meant "this map", so the entry is opened
      // for them, exactly as it is when the same file is dropped on the picker.
      // The finest resolution, which is what `firstEntry` picks; if it is the
      // wrong one the bin-size clause of the gate says so by name.
      const landing = firstEntry(err)
      if (landing !== null) {
        this.compareOpening = null
        await this.openCompare(`${splitUri(uri).path}::${landing.group}/${landing.entry}`, source)
        return
      }
      this.compareCard?.set({
        kind: 'error',
        label: fileLabel(uri),
        message: err instanceof Error ? err.message : String(err),
      })
      this.forget(uri)
    } finally {
      this.compareOpening = null
    }
  }

  /**
   * Take a refused second file out of the view state.
   *
   * The state is what {@link render} reconciles against, so a `uri2` that will
   * never open is a *standing* instruction to try opening it — a fresh worker
   * and a fresh header read on every navigation, for a file that was already
   * refused. The card keeps the reason; the hash stops claiming a comparison
   * that is not on screen.
   */
  private forget(uri: string): void {
    const held = this.store.state?.uri2
    if (held === undefined || this.compare !== null) return
    // The *file*, not the URI: a link naming an `.mcool` at its root is refused
    // under the entry URI it was redirected to, and comparing the two strings
    // would leave the original in the hash to be retried for ever.
    if (held !== uri && splitUri(held).path !== splitUri(uri).path) return
    this.store.patch({ uri2: undefined }, { replace: true })
  }

  /**
   * Put the second file down.
   *
   * `which === 1` closes the *first* one, and the second takes its place: the
   * comparison is symmetric in everything except which triangle each file is
   * in, so closing either has to leave an ordinary one-file map behind. Closing
   * the first is therefore an `open` of the second, carrying nothing but the
   * view — the colour clip is in the first file's counts and means nothing in
   * the second's, exactly as it does not survive a change of resolution.
   */
  private closeCompare(which: 1 | 2): void {
    const held = this.compare
    if (held === null) return
    if (which === 2) {
      this.dropCompare()
      this.store.patch({ uri2: undefined })
      this.remount()
      return
    }
    const state = this.store.state
    this.dropCompare()
    const carry =
      state === null
        ? undefined
        : (({ vmin: _vmin, vmax: _vmax, uri2: _uri2, ...rest }) => ({ ...rest, uri: held.uri }))(
            state,
          )
    void this.open(held.uri, held.source, carry)
  }

  /**
   * Swap which file is above the diagonal — the same comparison, read the other
   * way.
   *
   * Reopening rather than relabelling, because "which file is first" is not a
   * label: the first file is the one whose contigs table the axes come from,
   * whose tracks are drawn, and whose breadcrumb is on screen. Both sources are
   * held here, so a *local* second file survives the swap — which a round trip
   * through `uri2` and `inferSource` could not manage (§11).
   */
  private async swapCompare(): Promise<void> {
    const held = this.compare
    const file = this.file
    if (held === null || file === null) return
    const state = this.store.state
    const carry =
      state === null
        ? undefined
        : (({ vmin: _vmin, vmax: _vmax, uri2: _uri2, ...rest }) => ({ ...rest, uri: held.uri }))(
            state,
          )
    const previous = { uri: file.uri, source: file.source }
    this.dropCompare()
    await this.open(held.uri, held.source, carry)
    if (this.destroyed) return
    await this.openCompare(previous.uri, previous.source)
  }

  /**
   * What the whole-file view's cache key has to carry about the comparison.
   *
   * That slot holds the result of a full pass over every stored pixel, keyed on
   * *what was read*. A second file arriving, leaving, or being rescaled all
   * change what the picture is of, so each of them has to miss the cache — the
   * alternative is a whole-genome map that keeps showing one file after a second
   * has been dropped on it.
   */
  private compareKey(): string {
    return this.compare === null ? '' : `${this.compare.uri}|${String(this.normalising())}`
  }

  private dropCompare(): void {
    this.compare?.client.terminate()
    this.compare = null
    this.compareCard?.set({ kind: 'empty' })
    this.infoPanel?.setCompare(null)
  }

  /**
   * Whether the second file's counts are scaled to the first's bright end.
   *
   * A preference rather than view state: it changes how the picture is drawn and
   * not what is in it, and it is per session because it is a fact about *these
   * two files* — one being shallower than the other — rather than about the
   * viewer.
   */
  private normalising(): boolean {
    return recall<boolean>(this.memoryKey(this.file?.uri ?? ''), 'compare:normalise') === true
  }

  /** What a heatmap view needs to read and label the second file, or `undefined`. */
  private compareContext(): CompareRead | undefined {
    const held = this.compare
    const file = this.file
    if (held === null || file === null) return undefined
    return {
      client: held.client,
      labels: [fileLabel(file.uri), fileLabel(held.uri)],
      normalise: this.normalising(),
      onNormaliseChange: (on) => {
        remember(this.memoryKey(file.uri), 'compare:normalise', on)
        this.remount()
      },
      onFailure: (message) => {
        // Terminating the second reader rejects its in-flight reads, which
        // arrive here as failures — of a comparison that is no longer on
        // screen, on a card that is now offering to start a new one.
        if (this.compare !== held) return
        this.compareCard?.set({ kind: 'error', label: fileLabel(held.uri), message })
      },
    }
  }

  /**
   * Rebuild the mounted view for the state it is already in.
   *
   * The one thing a view cannot be told about after it is built is which blocks
   * it should have read, and both of the things that reach here — a second file
   * arriving or leaving, and the gain applied to it — change exactly that.
   * Clearing `mounted` is what makes the next render a navigation rather than a
   * repaint.
   */
  private remount(): void {
    const state = this.store.state
    if (state === null) return
    this.mounted = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    void this.render(state)
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
      this.assembly = null
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

    // The browser branch comes first, because it is the one shape of session
    // that has no `file` at all — falling through to the check below would
    // re-open the assembly's source file on every navigation inside it.
    if (state.view === 'browser') {
      if (this.assembly?.uri === state.uri) {
        this.breadcrumbHost.replaceChildren()
        this.mounted = state
        if (this.browser === null) this.mountBrowser(state)
        else this.browser.applyLocus(state.locus)
        this.host.activity(this)
        return
      }
      if (this.opening !== null) return
      const source = inferSource(state.uri)
      if (source === null) {
        this.showContent(this.pickerWithNote(state.uri))
        return
      }
      await this.openGenome(state.uri, source, state.locus, true)
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

    // A link may carry a second file (`uri2`), and the tab may already hold one
    // — or the wrong one. Reconciled here rather than at the drop, so a pasted
    // comparison and a dropped one arrive by the same road.
    //
    // The mount below is *not* deferred until the second file has opened: the
    // first file's map is a complete picture on its own, and showing it while
    // the second is read is better than showing nothing. `remount` brings the
    // comparison in when it lands.
    const wanted = state.uri2 ?? null
    if (wanted !== (this.compare?.uri ?? null)) {
      if (wanted === null) this.dropCompare()
      else {
        const source = inferSource(wanted)
        // The same refusal a local `uri` gets, for the same reason: no browser
        // re-reads a dropped file without a gesture, so a link naming one has
        // nothing to open. Dropped from the hash rather than left there
        // describing a comparison that is not on screen.
        if (source === null) {
          this.store.patch({ uri2: undefined }, { replace: true })
          return
        }
        void this.openCompare(wanted, source)
      }
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
      `whole|${state.uri}|${this.compareKey()}|${level}|${String(balance)}`,
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
          ...(this.compareContext() === undefined ? {} : { compare: this.compareContext() }),
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
      ...(this.compareContext() === undefined ? {} : { compare: this.compareContext() }),
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
      ...(this.compareContext() === undefined ? {} : { compare: this.compareContext() }),
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
      /** For a view that owns a canvas but not a {@link MatrixPanel}. */
      remeasure?(): void
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

/**
 * Name and length per chromosome, in file order — what the compare gate reads.
 *
 * Both, because both have to match: a renamed assembly and a re-scaffolded one
 * are different failures and the gate names each of them (`ui/CompareCard.ts`).
 */
function contigPairs(contigs: ContigsResult | null): Array<[string, number]> {
  const names = contigNames(contigs)
  const lengths = contigs?.table.data['length']
  if (lengths === undefined || Array.isArray(lengths)) return names.map((name) => [name, 0])
  return names.map((name, index) => [name, Number(lengths[index])])
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
