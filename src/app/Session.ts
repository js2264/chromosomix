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

import { AnnotationLoader, leadOf, pairIndexes } from '../annotations/loader'
import { ManualStore, type ManualMark } from '../annotations/manual'
import { GroupSettings } from '../annotations/groups'
import { AnnotationStore } from '../annotations/store'
import { AnnotationClient } from '../annotations/worker/client'
import { AnalysisClient } from '../analysis/worker/client'
import type { CorrelationField } from '../analysis/compartments'
import { buildAnalysisContext } from '../analysis/context'
import type { AnalysisContext, AnalysisFraming, TableOutput } from '../analysis/types'
import type {
  AnalysisWorkspace,
  AnalysisWorkspaceHost,
  CarriedResult,
} from '../analysis/workspace'
import { UNBINNED_NAME } from '../constants'
import { CircularStore } from '../state/circular'
import { ViewerError } from '../errors'
import {
  COMPANION_KEYS,
  READING_KEYS,
  SUBJECT_KEYS,
  ViewStore,
  differsOnlyInFocus,
  differsOnlyInPresentation,
  cellsOf,
  cellsPatch,
  landingState,
  matrixLevel,
  overviewLevel,
  selectionOf,
  sequencesShown,
  viewForSequences,
  viewStateEquals,
  type UnitSelection,
} from '../state/ViewState'
import { parseRegionString } from '../metacooler/range'
import { fileMemoryKey, recall, remember } from '../state/UiMemory'
import { getPlotOptions, setPlotOptions } from '../ui/plotOptions'
import type { PanelLayout } from '../ui/SidePanel'
import { armAll, resetPick, type Armable, type PickHandlers } from '../ui/mapPick'
import { BALANCED_SCORE, COUNT_SCORE, scoreChoices, scoreFor, type ScoreChoice } from '../ui/scores'
import {
  applyConfig,
  buildConfig,
  looksLikeConfig,
  resolveConfig,
  SESSION_NAME_SCOPE,
  type SessionConfig,
} from '../state/SessionConfig'
import type { CompareOp, Transform, ViewKind, ViewState } from '../types'
import type { Normalisation, SmoothedField, SmoothingRequest } from '../render/derive'
import { parseSmooth } from '../render/smooth'
import type { RotateDirection } from '../render/rotate'
import { LEAD_MAP, type Lane } from '../annotations/placement'
import type {
  CircularPresentation,
  DerivePresentation,
  TurnPresentation,
} from '../ui/MatrixPanel'
import { isCancellation, ReaderClient, type Cancellable } from '../worker/client'
import type {
  CellsResult,
  ContigsResult,
  GenomesResult,
  McoolExport,
  OpenResult,
  OrientationSummary,
  PairsBinning,
  PairsImportSummary,
  PairsProbeResult,
  SourceSpec,
  TablePayload,
} from '../worker/protocol'
import type { WireSource } from '../annotations/worker/protocol'
import type { PickedFile } from '../browse/folder'
import { routeOf, type FileRoute } from '../browse/route'
import { isHicProMatrix, splitBinsFragment, splitIndexFragment } from '../annotations/sidecar'
import { readFileDrag } from '../ui/fileDrag'
import {
  assemblyOf,
  browsingBinsize,
  findContig,
  formatLocus,
  lengthsAreExact,
  parseLocus,
  replacesLengths,
  type Assembly,
  type AssemblyOrigin,
  type Contig,
} from '../genome/assembly'
import { NameIndex } from '../genome/naming'
import { SequenceSelection } from '../genome/selection'
import { placementOn, type AnnotationEntry, type Placement } from '../annotations/types'
import { AnnotationCard } from '../ui/AnnotationCard'
import { Breadcrumb } from '../ui/Breadcrumb'
import { BrowserView } from '../ui/BrowserView'
import { CompareCard, compareRefusal } from '../ui/CompareCard'
import type { CompareRead } from '../ui/compare'
import { PanelDeck } from '../panels/PanelDeck'
import { DeckFrame } from '../panels/DeckFrame'
import { MAX_PANELS, parseMaps, type DeckLocal, type GrowDirection } from '../panels/deck'
import type { AnalysisFacts } from '../panels/MapPanel'
import type { RunTarget } from '../analysis/runner'
import { ManualCard, type MapPicker } from '../ui/ManualCard'
import { downloadBlob, exportBaseName, fileStamp } from '../ui/export'
import { MetadataCard } from '../ui/MetadataCard'
import { metadataIndexFrom, type MetadataIndex } from '../annotations/metaIndex'
import { summaryOf, type MetaLevel } from '../annotations/metadata'
import { BookmarkStore, formatRegion, type Bookmark } from '../annotations/bookmarks'
import { BookmarksCard } from '../ui/BookmarksCard'
import type { AnnotationContext, MatrixPanel } from '../ui/MatrixPanel'
import { ContigsTable } from '../ui/ContigsTable'
import { ErrorView } from '../ui/ErrorView'
import { FilePicker, firstEntry } from '../ui/FilePicker'
import { openPairsDialog } from '../ui/PairsDialog'
import { progressToast } from '../ui/toast'
import { askLoadCost, isLoadGate } from '../ui/LoadGate'
import { GenomeView, type ScaleState } from '../ui/GenomeView'
import { CellsTable, type MeasuredCells } from '../ui/CellsTable'
import { GenomesTable } from '../ui/GenomesTable'
import { InfoPanel } from '../ui/InfoPanel'
import { MinimapCard, suitsMinimap, type MinimapRange } from '../ui/MinimapCard'
import { Overview, wholeFileLevelCard } from '../ui/Overview'
import { PairView } from '../ui/PairView'
import { findRow, recordFields, type RecordField, type RecordSpec } from '../ui/RecordCard'
import { RegionView } from '../ui/RegionView'
import { BROWSER_TICKS, MAP_TICKS, sequenceCard } from '../ui/SequenceCard'
import { WholeView } from '../ui/WholeView'
import type { TableUiState } from '../ui/VirtualTable'
import { KEYS, keyedIconButton, withKey, type Command } from '../ui/commands'
import { button, el, fmt } from '../ui/dom'
import { cardTitle, iconButton } from '../ui/icons'
import { demoAnnotationsToOffer } from '../ui/examples'
import { contigOf, fileLabel, neighbour, sourceNote, splitUri } from '../ui/labels'
import { logAction } from '../state/actions'
import {
  MAP_NAMES_SCOPE,
  mapLabelIn,
  mapNameIn,
  readMapNames,
  withMapName,
  type MapNames,
} from '../ui/mapNames'
import { rungsOf } from '../ui/refine'
import { accessHeaders } from '../sources/access'
import { canonicalUrl } from '../sources/rewrite'
import { accessHeadersFor, credentialFor } from '../s3/credentials'
import { inferSource, mayResolve, resolveSource } from './resolve'
import { rememberHandle } from '../state/handles'
import { grantFor } from '../ui/chooseFiles'

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
  /** Open the store drawer on this store — a tile on the landing page was pressed. */
  openStore(id: string): void
  /**
   * A saved workspace arrived — as a dropped file, or fetched from a URL.
   *
   * The shell's, not a session's: a workspace is *N tabs* and a session
   * deliberately knows nothing about the window it sits in. `base` is where the
   * file was found, for resolving the relative names a published one carries;
   * absent for a dropped file, which has no folder a page can see.
   */
  openWorkspaceFile(text: string, label: string, base?: string): void
  /**
   * How the window's columns stand, and how to put them back.
   *
   * The shell's, because the columns are: a session is handed four hosts to fill
   * and owns none of the panels around them (§16.5). They are here so that a
   * session can put them into the config it builds and take them out of one it
   * opens, which is exactly what it already does with the overlay preferences.
   */
  panelLayout(): PanelLayout
  applyPanelLayout(layout: PanelLayout | undefined): void
  /** Say something quiet and dismissible about what just happened. */
  notify(message: string): void
  /** A read finished; the status bar's counters are worth another look. */
  activity(session: Session): void
}

/** What a heatmap view of the whole file at once has to offer the session. */
interface WholeFileView {
  readonly el: HTMLElement
  readonly sideEl: HTMLElement
  readonly panel: MatrixPanel
  applyScale(scale: ScaleState): void
  /** The box in the heading — where `/` puts the caret. */
  focusSearch(): void
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
  /**
   * The cells table of an `.scool`, fetched the first time it is shown.
   *
   * Lazily like `contigs` and for the same reason: it is a view's data, not an
   * open's. The *names* did arrive at open — they had to, since the reader
   * cannot address a cell without them — and this is the rest of the table.
   */
  cells: CellsResult | null
  /**
   * Which cells the worker is currently summing.
   *
   * The session's copy of state that lives in the worker, so a navigation that
   * does not change the set does not pay for a swap. `null` on a file with no
   * cells, and on one whose set is still every cell.
   */
  activeCells: string[] | null
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
  // The sidecar goes with the file on both roads. For a FASTA the *assembly*
  // question is answered from its `.fai` when there is one (§8.8), and a
  // question asked without the index would read a gigabyte to learn what the
  // index says in a kilobyte.
  return source.kind === 'local'
    ? {
        kind: 'local',
        file: source.file,
        name: source.file.name,
        ...(source.index === undefined ? {} : { index: source.index }),
      }
    : {
        kind: 'remote',
        url: source.url,
        name: source.url.split('/').pop() ?? source.url,
        ...(source.index === undefined ? {} : { index: source.index }),
      }
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
function genomeCard(
  assembly: Assembly,
  onGoTo: (locus: string) => void,
  selection: SequenceSelection,
  /**
   * The minimap, where this genome is one a strip can usefully be drawn of.
   *
   * Passed in rather than built here because it is *kept*: the strip has to be
   * told where the window moved to on every pan, and a card rebuilt from a
   * function that takes no location could only ever show the place the column
   * was last assembled at. `Session` holds it and updates it; this only decides
   * where in the column it sits.
   */
  minimap?: HTMLElement,
): HTMLElement {
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
      cardTitle('Genome', 'dna'),
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
    // Above the sequence list rather than below it: the strip is the picture of
    // the same thing the list is a table of, and a reader looking for *where am
    // I* should not have to scroll past sixteen rows to find out.
    ...(minimap === undefined ? [] : [minimap]),
    sequenceCard({
      contigs: assembly.contigs,
      selection,
      onGoTo,
      ...BROWSER_TICKS,
    }),
    // No card about contact maps here. There is one in the Annotations column,
    // it lists the maps this session holds however many that is, and each of
    // them wears the eye that decides whether it is drawn — which is a column
    // about *what is on screen* rather than about what the file is. Two cards
    // offering to load a map, in two columns, is the state this replaced.
  )
}

/**
 * A `contig:start-end` region as the range the minimap draws, or `null`.
 *
 * The region grammar is the map's — 0-based, half-open, and either coordinate
 * may be omitted to mean the whole sequence — which is already what
 * `MinimapRange` is, so this is a parse and a fill-in rather than a conversion.
 * A name the assembly does not have yields `null` rather than a guess: a
 * highlight in the wrong place is worse than no highlight, because it is not
 * visibly wrong.
 *
 * `parseRegionString` throws on a malformed region, and a malformed region here
 * is not an error worth surfacing — the state is already on screen and the map
 * has already refused it — so it is caught and read as "nowhere".
 */
function minimapRange(region: string, assembly: Assembly): MinimapRange | null {
  let name: string
  let from: number | null
  let to: number | null
  try {
    ;[name, from, to] = parseRegionString(region)
  } catch {
    return null
  }
  const contig = findContig(assembly, name)
  if (contig === null) return null
  return {
    contig: contig.name,
    start: from ?? 0,
    end: to ?? contig.length,
  }
}

/**
 * The minimap's own `contig:first-last` back as a `LocusRange`.
 *
 * The card emits the string `SequenceBar` emits — 0-based, half-open, no
 * thousands separators — and the browser is driven by `formatLocus`, which is
 * 1-based and inclusive. One of the two has to convert and this is the seam;
 * `state/ViewState.ts` and `ui/SequenceBar.ts` both explain why the two
 * conventions are kept apart rather than reconciled.
 */
function rangeOfRegion(region: string): { contig: string; start: number; end: number } {
  const at = region.lastIndexOf(':')
  if (at < 0) return { contig: region, start: 0, end: 0 }
  const [first, last] = region.slice(at + 1).split('-')
  return { contig: region.slice(0, at), start: Number(first), end: Number(last) }
}

/** How each kind of source is described in the Genome card. */
const ORIGINS: Record<Assembly['origin'], string> = {
  sizes: 'declared by a chrom.sizes',
  bigwig: 'from the bigWig header',
  bigbed: 'from the bigBed header',
  fasta: 'the sequences themselves',
  features: 'inferred from the features',
  cooler: 'from the cooler’s /chroms',
  bam: 'from the BAM’s @SQ header',
  vcf: 'declared by the VCF’s ##contig lines',
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
 * The second file, held across a change of resolution rather than dropped with
 * the first.
 *
 * A comparison belongs to the file it is a comparison *of*, which is why
 * opening another file puts it down. Switching rung is the one case where that
 * reasoning does not apply: it is the same file at another bin size, the reader
 * did not close anything, and the two maps were being read against each other a
 * moment ago. Dropping the second there is losing a file the reader would have
 * to find and open again at every zoom level — and losing it *silently*, since
 * the first map is a complete picture on its own and nothing on screen says the
 * other one has gone.
 *
 * What is kept is deliberately not the worker: the second file has to be
 * re-opened at its *own* rung, because the gate refuses two different bin sizes
 * and is right to. So this is the four facts that address it again — where it
 * came from, which rungs it has, and how the reader was reading it — and
 * {@link Session.restoreCarriedCompare} is where they are spent.
 */
export interface CompareCarry {
  uri: string
  source: SourceSpec
  /** Sibling rungs of the second file's own collection; `[]` for a plain file. */
  entries: readonly string[]
  /** The group they live under — `resolutions` for an mcool. */
  entryGroup: string
  /** The bin size it was open at, so an unchanged one needs no arithmetic. */
  binsize: number | null
  /** Whether its triangle was hidden, which is a fact about the reading. */
  hidden: boolean
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
  /**
   * The file's own tables, as the metadata card and the lanes read them (§8.12).
   *
   * Absent in a 1D genome browser, which is the one session with annotations
   * and no contact map: its axis is an assembly's sequences and there is no
   * `/genomes`, `/contigs` or `/bins` behind it to have columns of.
   */
  metadata?: MetadataIndex
  /**
   * How each group of tracks is drawn and scaled, for this file.
   *
   * One instance handed to every surface rather than one per view: a group is a
   * fact about the tracks, so overlaying two of them in the 1D browser and then
   * dropping a `.cool` on it must find the same two still overlaid beside the
   * map (`annotations/groups.ts`).
   */
  groups: GroupSettings
  contigLength(name: string): number | undefined
}

/**
 * A framing with the reader's circular declarations attached.
 *
 * A free function rather than a method, and applied at the *session* level
 * rather than in the panel, because the declaration is about the **file** while
 * a panel knows about the one sequence it is showing. A task run from a
 * whole-genome view on a file with three circular plasmids has to measure all
 * three of them the short way round, and a framing carrying only what happened
 * to be on screen would give one answer from one view and another from another
 * (SPECS §8.15).
 *
 * `null` in, `null` out: a session with no block on screen has no framing, and
 * a declaration does not make one.
 */
function withCircularNames(
  framing: AnalysisFraming | null,
  names: readonly string[],
): AnalysisFraming | null {
  if (framing === null || names.length === 0) return framing
  return { ...framing, circular: names }
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
  /** The Analysis column's body: the list of tasks this file can be asked. */
  readonly analysisHost = el('div', { class: 'panel-host' })
  /**
   * Where this session's Analysis drawer lives while the tab is on screen.
   *
   * The drawer is per session and not per window — a folded column is a
   * preference about the window, an open task is a fact about the file — so it
   * is built here and the shell only lends it a slot (§18.1).
   */
  readonly drawerHost = el('div', { class: 'drawer-host' })
  /**
   * Where the synthetic tracks card sits, inside the Annotations column.
   *
   * A **marker**, never mounted, rather than a wrapper the card goes inside.
   *
   * The two are created at different moments — the annotation cards when a
   * file's assembly is known, the workspace that owns the synthetic card after
   * the *view* mounts, since it needs the framing — so the list has to be built
   * before the card exists. The obvious answer is an empty `.panel-host` div
   * that the card is later dropped into, and it was the answer here, and it was
   * wrong: `.panel-host` is `display: contents`, so a card inside one inside
   * `annotationsHost` is a *third* DOM level, and the stylesheet's
   * `.panel-column-body > .panel-host > .card` rule stops at the second. The
   * card lost `flex: 0 0 auto`, was squeezed to the height of its own title, and
   * grew a scrollbar of its own — the exact bug that rule was written to fix,
   * one level deeper, which is what a depth-counting selector always costs.
   *
   * So the list carries a marker and {@link renderAnnotations} substitutes the
   * real card for it, or drops it. No wrapper, no third level, and the position
   * of the card in the column stays where the call site put it.
   */
  private readonly syntheticSlot = el('div')
  /** The analysis card, once the workspace exists. Substituted for the marker. */
  private syntheticCard: HTMLElement | null = null
  /** The annotation list as its call site wrote it, marker included. */
  private annotationNodes: readonly HTMLElement[] = []
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
   * The genome strip, where this session's genome is one worth drawing.
   *
   * Held rather than rebuilt, because it is told where the view moved to on
   * every navigation and every pan ({@link syncMinimap}) — a card reassembled
   * from a function that takes no location could only show the place the column
   * was last built at. One at a time: a session is of one genome, and the map
   * column and the browser column never both hold one.
   */
  private minimap: MinimapCard | null = null
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
  /**
   * The URI a *resolve* is in flight for, which is one step earlier than
   * {@link opening}.
   *
   * Asking whether this browser still holds a grant for a local file is
   * asynchronous, and the question is asked from inside `render` — between the
   * `opening` guard and the call it protects. Without a latch of its own, two
   * renders both pass that guard, both resolve, and both open: two workers, two
   * h5wasm instances, and every panel's memory budget halved, with nothing
   * thrown and nothing logged.
   *
   * Mirrors `opening` rather than reusing it, because the two mean different
   * things to everything else that reads them — a session that is *resolving* is
   * not yet opening anything and must not be described as busy with a file.
   */
  private resolving: string | null = null
  private current: {
    destroy?(): void
    applyScale?(scale: ScaleState): void
    /**
     * Move to a saved place without being rebuilt (§8.10).
     *
     * Present on the region view alone, which is the only one whose block has a
     * diagonal a single locus names. Its absence is what routes every other view
     * through the ordinary rebuild for a `focus` change, rather than a list of
     * view kinds kept in the render path.
     */
    showFocus?(region: string | undefined): void
    /** Present on the heatmap views; the manual card places marks through it. */
    panel?: MatrixPanel
    /** Present on the genome browser, which owns a canvas of its own. */
    remeasure?(): void
    /**
     * Put the caret in whatever box this view is typed into — the `/` key.
     *
     * Optional because two views have no such box: a `.metacool`'s scan is a
     * picture with no coordinate to type, and the picker is a drop zone. A
     * command whose target is absent is listed disabled rather than hidden, so
     * the key is still documented where a reader looks for it.
     */
    focusSearch?(): void
    /**
     * Adopt a change of the circular declaration without being rebuilt (§8.15).
     *
     * Present on the region view alone, for {@link showFocus}'s reason: it is
     * the only view a sequence can be declared circular from. Its absence is
     * what makes the toggle a no-op elsewhere rather than a remount of a view
     * the declaration does not change.
     */
    setCircular?(on: boolean): void
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
  /** The Metadata card (§8.12); rebuilt with the file, like every other card. */
  private metadataCard: MetadataCard | null = null
  private bookmarksCard: BookmarksCard | null = null
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
  /**
   * The second map is open and *not drawn* — its eye is shut.
   *
   * Distinct from having no second map at all: the reader stays alive and the
   * card keeps its row, so the lower-left triangle comes back on the next press
   * rather than on another read of another file. The same distinction the first
   * map's {@link parkedMap} makes, and the same one a track's `visible` makes.
   */
  private compareHidden = false
  private compareCard: CompareCard | null = null
  /** The URI a compare open is in flight for, so a re-render does not restart it. */
  private compareOpening: string | null = null
  /**
   * The second file, waiting out a change of resolution — see {@link CompareCarry}.
   *
   * Set the moment an open is known to be a re-open of the file already here,
   * and spent by the first {@link restoreCarriedCompare} after it lands. `null`
   * at every other moment, including a failed open: the catch re-enters
   * {@link open} for the entry it was redirected to, and the carry is taken
   * again there from a comparison that is still standing.
   */
  private compareCarry: CompareCarry | null = null
  /**
   * Further files, each in a panel of its own beside this one (§16).
   *
   * The other generalisation of "two files", and orthogonal to {@link compare}
   * rather than a replacement for it: the triangle is two files in one square,
   * this is N squares under one navigation, and a session may hold both. Built
   * on demand and put down when the last companion is closed, so a session with
   * one map is exactly the session it was before decks existed — no grid, no
   * lock, no toolbar.
   */
  private deck: PanelDeck | null = null
  /**
   * The `+` edges round a map that has no deck yet (§16.9).
   *
   * The session holds one because the gesture has to exist *before* the feature
   * does: a reader with one map has nothing on screen telling them this viewer
   * can put another beside it, and the command palette is not a place anybody
   * looks for a thing they do not know exists. Once a deck is built it grows its
   * own edges round its grid and this one goes back to holding nothing — the
   * same component either way, so pressing `+` on a deck of four is visibly the
   * same act as pressing it on a map of one.
   */
  private readonly deckEdges = new DeckFrame({
    onGrow: (direction, picked) => this.growDeck(direction, picked),
  })
  /**
   * The genome this session is browsing, when there is no contact map.
   *
   * A session is in one of two shapes and this is the discriminant: with a
   * {@link file} it is a map browser with tracks beside the map, with an
   * assembly it is a 1D genome browser with the same tracks and no map.
   *
   * A file *and* an assembly is the third state, and the only one: the map is
   * **hidden** rather than closed, and {@link parkedMap} says so. What is on
   * screen is still decided by the assembly — this is the 1D browser — but the
   * reader worker is alive, the file is open, and the picture comes back from
   * where it was left. Opening a map from a browser still replaces the assembly
   * outright, and closing one still falls back to it.
   */
  private assembly: Assembly | null = null
  /**
   * The file {@link assembly} was read from, in the shape a worker opens.
   *
   * The assembly itself carries a URI and no handle, and a name is not something
   * a browser can read bytes through. Kept beside it because a session with no
   * contact map still *runs tasks* — a metaplot, a track correlation, an interval
   * overlap (§18.3) — and every result is a record that names the file it is a
   * measurement of. Without it the runner had a framing and no target, and each
   * of those three failed with "nothing is open" in the one session shape they
   * exist for.
   */
  private assemblySource: SourceSpec | null = null
  /**
   * Where the map goes back to while the browser is on screen.
   *
   * Non-null is the whole of "there is a map behind this": {@link file} and the
   * reader are untouched, and this is the view state to return to. The eye
   * beside the file's name in the Contact maps card is what sets and clears it,
   * which is the same control a track's own row carries — a map is a thing laid
   * over this genome too, and the largest of them.
   */
  private parkedMap: ViewState | null = null
  /**
   * `true` while the reader has asked for the map without its tracks.
   *
   * The third stop of the map/tracks cycle. A field rather than a key in the
   * state, and that is the one thing about it worth knowing: it survives every
   * navigation of this session and is not in a link, because it is furniture
   * around the picture rather than any part of what the picture is *of*.
   */
  private mapOnly = false
  /**
   * The map/tracks button as it stands on screen, so it can be swapped in place.
   *
   * Held because one of the cycle's three steps rebuilds no view, and a control
   * that is not rebuilt keeps the face it was given.
   */
  private mapSwitch: HTMLElement | null = null
  private browser: BrowserView | null = null
  /** Which sequences are on the browser's axis; see {@link selectionFor}. */
  private sequences: SequenceSelection | null = null
  /** Drop the map's listener on that selection; see {@link paintSequences}. */
  private sequenceListener: (() => void) | null = null
  /**
   * `true` for the length of one write of the ticks *from* the view state.
   *
   * The binding runs both ways — a tick navigates, a navigation re-ticks — so
   * without this the second half answers the first and the pair oscillates.
   */
  private echoingSequences = false
  /**
   * A config waiting for the file it describes.
   *
   * An exported session names its file; a local one cannot be re-opened from a
   * name, so the config sits here while the picker asks for it and is applied to
   * whatever is dropped next. Cleared when it is used, so a reader who ignores
   * the note and opens something else entirely gets that file plain.
   */
  private pendingConfig: SessionConfig | null = null
  /**
   * The config being applied, for the length of one open.
   *
   * A workspace is written under the *file's* memory key, and a collection
   * addressed at its root does not stay under the URI it was asked for: it
   * redirects onto one of its entries (§3.4). Without this the tracks, groups
   * and ticked sequences of a published session naming an `.mmetacool` or an
   * `.mcool` were written under the root's key and read back under the entry's,
   * so the map arrived correctly and alone.
   */
  private redirectedConfig: SessionConfig | null = null
  /**
   * The Analysis panel, the drawer and the synthetic tracks card (§18).
   *
   * One object for all three, because they share a runner and a worker and are
   * created and destroyed together with the file — see `analysis/workspace.ts`
   * for why the wiring lives there rather than adding three hundred lines here.
   * `null` until a file is open, and dropped with it.
   */
  private analysis: AnalysisWorkspace | null = null
  /** Set while the workspace's chunk is in flight, so it is fetched once. */
  private analysisLoading = false
  private generalOn = false
  private annotationsOn = false
  private aestheticsOn = false
  private analysisOn = false
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
      onOpen: (uri, source) => void this.openWithConfig(uri, source),
      onOpenFiles: (files) => void this.openFiles(files),
      // The tiles are the shell's door: a store is a drawer over the window,
      // not a fact about this tab (`ui/StoreDrawer.ts`).
      onStore: (id) => this.host.openStore(id),
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

  /** `true` while the open file is a single-cell container (§3.8). */
  get isScool(): boolean {
    return this.file?.info.layout.kind === 'scool'
  }

  /** The reader client, or `null` where nothing has ever been opened here. */
  get client(): ReaderClient | null {
    return this.reader
  }

  /**
   * What the tab says: what the reader called it, else the file name, else the
   * invitation that replaces both.
   *
   * The name wins over the file and is never *written* from it, which is the
   * whole of the difference between a name and a default: a session called
   * `wild type` stays called that through a change of resolution, a redirect
   * into an entry of a collection, and a re-drop of the same file under another
   * path, because none of those is a reader renaming anything.
   */
  get label(): string {
    const name = this.name
    if (name !== null) return name
    const state = this.store.state
    if (state !== null) return fileLabel(state.uri)
    return 'New session'
  }

  /**
   * The name this tab has been given, or `null` for none.
   *
   * Read out of session memory rather than held on the instance, which is the
   * rule every other per-session setting in this file follows (§8.6): what
   * storage holds *is* the session, so a name and the tracks beside it come back
   * on the same terms and `buildConfig` cannot gather a config that disagrees
   * with the strip.
   *
   * Keyed on the file, like everything else under that key — so opening a
   * *different* file in this tab hands the tab back to its file name. That is
   * the right answer rather than a limitation: a name is what the reader calls
   * this piece of work, and replacing the file is replacing the work.
   */
  get name(): string | null {
    const state = this.store.state
    if (state === null) return null
    const held = recall<string>(this.memoryKey(state.uri), SESSION_NAME_SCOPE)
    return typeof held === 'string' && held.trim() !== '' ? held.trim() : null
  }

  /**
   * Call this tab something, or hand it back to its file.
   *
   * A blank name is *no name* rather than an empty label, which is what makes
   * clearing the box the way back: a tab called nothing at all would be an
   * unclickable sliver in the strip, and there would be no gesture to undo it
   * with.
   *
   * Refused where there is nothing open, and not for want of anywhere to put it:
   * the memory is keyed on the file, so a name given to an empty tab would be
   * written under a key nothing will ever read and would appear to be silently
   * forgotten. The strip does not offer the gesture there for the same reason.
   */
  rename(name: string | null): void {
    const state = this.store.state
    if (state === null) return
    const wanted = name === null ? '' : name.trim()
    if (wanted === (this.name ?? '')) return
    // The empty string rather than a delete: `UiMemory` has no way to forget a
    // scope, and the getter above already reads blank as no name — so one
    // representation, and the way back is writing it.
    remember(this.memoryKey(state.uri), SESSION_NAME_SCOPE, wanted)
    this.host.sessionChanged(this)
  }

  /** One line for the tab's tooltip: what it holds, or why it holds nothing. */
  get tabHint(): string {
    const state = this.store.state
    if (state === null) return 'Nothing open here yet — drop a file, or pick one from the list.'
    // A named tab hides its file, which is the point of naming one and also the
    // one thing that gets lost by it: four tabs called after the condition are
    // four tabs whose file nobody can see. So the tooltip leads with the URI it
    // has always led with, and the name is what the strip shows.
    if (this.name !== null && !this.primed) return `${this.label} — ${state.uri}`
    if (this.primed) {
      // Three answers where there used to be two, and the middle one is the
      // point of the whole feature: a local file this browser still holds a
      // grant for opens on a click like a remote one, so saying "drop it again"
      // would be sending the reader to find a file the app can already reach.
      //
      // `mayResolve` rather than the async resolver, because this is a getter
      // read in a loop by `App.paintTabs` on every state change — see
      // `app/resolve.ts`. It may be optimistic: a grant can have been revoked
      // since, and being wrong costs one click while being pessimistic costs
      // the feature.
      if (inferSource(state.uri) !== null) return `${state.uri} — remembered, not yet read. Click to open it.`
      return mayResolve(state.uri)
        ? `${state.uri} — a local file, remembered from an earlier visit. Click to open it again.`
        : `${state.uri} — a local file, remembered from an earlier visit. ` +
            'Click, then drop the same file again to follow it; the view will be restored.'
    }
    return state.uri
  }

  /** Which of the four columns have anything to show for this session. */
  get panels(): {
    general: boolean
    annotations: boolean
    aesthetics: boolean
    analysis: boolean
  } {
    return {
      general: this.generalOn,
      annotations: this.annotationsOn,
      aesthetics: this.aestheticsOn,
      analysis: this.analysisOn,
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

  /**
   * What one cell of the mounted picture is — the level rule's input (§8.12).
   *
   * Read off the state rather than off the panel, because it is a fact about
   * what was *asked for*: the same two accessors every view builds its own
   * request with, so the card and the picture cannot come to disagree about
   * which level is on screen. `null` for the surfaces that are not a matrix —
   * the two tables and the 1D browser — where there are no cells to draw a
   * column against and the drop-down says so instead of offering everything.
   */
  private metadataLevel(): MetaLevel | null {
    const state = this.store.state
    if (state === null || this.current?.panel === undefined) return null
    switch (state.view) {
      case 'overview':
        return overviewLevel(state)
      case 'genome':
      case 'pair':
      case 'region':
      case 'whole':
      case 'selection':
        return matrixLevel(state)
      default:
        return null
    }
  }

  /**
   * Metadata rows a previous visit left in session storage (§8.6, §8.12).
   *
   * Brought back **ready** rather than detached, which is the whole difference
   * between this and every other restore in the app: there is no file to
   * re-open and no recipe to re-run, because the column is in the map that is
   * already open. A row naming a column this file does not have is kept and
   * marked — see `MetadataCard.row` for why it is not silently dropped.
   */
  private restoreMetadata(scope: string): void {
    const held = this.annotations
    if (held === null) return
    for (const row of AnnotationStore.stored(scope)) {
      if (row.source.kind !== 'metadata') continue
      const table = row.source.table
      const column = row.source.column
      if (table === undefined || column === undefined) continue
      held.store.begin({
        card: 'metadata',
        kind: row.kind,
        source: { kind: 'metadata', name: row.source.name, table, column },
        id: row.id,
        label: row.label,
        placement: row.placement,
        style: row.style,
        visible: row.visible,
      })
      const found = held.metadata?.columnFor(table, column) ?? null
      held.store.update(row.id, {
        status: 'ready',
        ...(found === null ? {} : { summary: summaryOf(found) }),
      })
    }
  }

  /**
   * One metadata column, written out as a TSV (§8.12, §18.7).
   *
   * At the column's own granularity and not the picture's, which is
   * `MetadataIndex.exportTsv`'s argument: a lane is drawn at whatever level the
   * view is, and a reader checking a bar against the file needs the rows the
   * file actually wrote.
   */
  private exportMetadata(entry: AnnotationEntry): void {
    const held = this.annotations
    const source = entry.source
    if (held?.metadata === undefined || source.kind !== 'metadata') return
    const text = held.metadata.exportTsv(source.table, source.column, this.file?.uri ?? '')
    if (text === null) return
    downloadBlob(
      new Blob([text], { type: 'text/tab-separated-values' }),
      `${exportBaseName(fileLabel(this.file?.uri ?? 'map'))}-${source.table}-${source.column}-${fileStamp(new Date())}.tsv`,
    )
  }

  /**
   * A metadata column landed: redraw the lanes that were waiting for it (§8.12).
   *
   * A repaint and not a re-render. Nothing about the *view* changed — the block
   * is the one that was already on screen and the store holds what it held —
   * only the numbers behind one lane arrived, which is exactly the state a
   * track is in when its samples come back.
   */
  private repaintMetadata(): void {
    this.current?.panel?.repaint()
    this.deck?.repaint()
    this.metadataCard?.refresh()
  }

  /** Re-measure whatever is mounted; a column moved or the window resized. */
  relayout(): void {
    this.current?.panel?.remeasure()
    this.current?.remeasure?.()
    this.deck?.relayout()
    this.analysis?.relayout()
  }

  destroy(): void {
    this.destroyed = true
    // The picker outlives every file this session opens and is torn down with
    // the tab, so its one subscription is released here rather than on each
    // navigation back to it.
    this.picker.destroy()
    this.minimap?.destroy()
    this.minimap = null
    this.analysis?.destroy()
    this.analysis = null
    this.current?.destroy?.()
    this.current = null
    this.deck?.destroy()
    this.deck = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.annotations?.client.destroy()
    this.annotations = null
    this.compare?.client.terminate()
    this.compare = null
    this.correlator?.terminate()
    this.correlator = null
    this.assembly = null
    this.sequenceListener?.()
    this.sequenceListener = null
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
    const isScool = this.isScool
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
          keys: KEYS.whole,
          run: () => this.store.patch({ locus: undefined }),
        },
        // The same two keys a map has, walking the same list. They were left out
        // of this branch, which made the browser the one view where the plainest
        // thing anybody does with a genome — look at the next chromosome — had to
        // be typed into the locus box.
        {
          id: 'go-prev',
          group: 'Go',
          title: 'Previous sequence',
          hint: this.stepTarget(-1) ?? undefined,
          keys: KEYS.previous,
          enabled: this.stepTarget(-1) !== null,
          run: () => this.step(-1),
        },
        {
          id: 'go-next',
          group: 'Go',
          title: 'Next sequence',
          hint: this.stepTarget(1) ?? undefined,
          keys: KEYS.next,
          enabled: this.stepTarget(1) !== null,
          run: () => this.step(1),
        },
        {
          id: 'fit-tracks',
          group: 'View',
          title: 'Stretch the tracks to fill the height',
          hint: 'One height for all of them, and that height the one that fills the space.',
          // `s` for stretch, which is what the button does and what a reader
          // calls it. It cost `s` its old meaning — autoscale, which is now `y`,
          // the axis it acts on — and that trade is the right way round: this is
          // the one a reader reaches for several times a session, while
          // autoscale is a repair for a bound typed into the wrong box.
          keys: KEYS.stretch,
          run: () => this.browser?.fitTracks(),
        },
        {
          id: 'shrink-tracks',
          group: 'View',
          title: 'Shrink the tracks to the shortest of them',
          // No key of its own. Stretch is the one a reader reaches for several
          // times a session; this is its way back, and a second letter for it
          // would be a letter spent on the rarer half of a pair.
          hint: 'One height for all of them, and that height the smallest one on screen.',
          run: () => this.browser?.shrinkTracks(),
        },
        {
          id: 'browser-export',
          group: 'File',
          title: 'Save this plot as a figure',
          hint: 'The Export card decides the format and the resolution; this is its button.',
          keys: KEYS.savePlot,
          run: () => this.browser?.savePlot(),
        },
        {
          id: 'browser-copy',
          group: 'File',
          title: 'Copy this plot to the clipboard',
          hint:
            'The figure as a PNG, at the Export card\'s resolution, ready to paste. With text ' +
            'selected the same key still copies the text.',
          keys: KEYS.copyPlot,
          yieldsToText: true,
          run: () => this.browser?.copyPlot(),
        },
        {
          id: 'browser-autoscale',
          group: 'View',
          title: 'Autoscale every track',
          hint: 'Hand every value axis back to what is in view; a group resolves as a group.',
          keys: KEYS.autoscale,
          run: () => this.browser?.autoscaleAll(),
        },
        {
          id: 'browser-search',
          group: 'Go',
          title: 'Find a gene, or go to a locus',
          // One command, because there is one box. It used to be two — `/` to
          // find and `l` to go — over the same field, and `l` was also the
          // labels overlay: in a browser session the overlay could not be
          // toggled at all, because the command list is searched in order and
          // this half of it comes first. Two names for one box is not worth a
          // key that silently does nothing somewhere else.
          hint:
            'One box takes all three: chrI:1,000-20,000, a sequence name, or a gene name from ' +
            'the starred model.',
          keys: KEYS.find,
          run: () => this.browser?.focusSearch(),
        },
        {
          id: 'show-map',
          group: 'View',
          title: 'The contact map on its own',
          hint:
            'The map was never unloaded — this is the same picture, where it was left, with the ' +
            'tracks put away. The same key brings them back.',
          keys: KEYS.mapToggle,
          enabled: this.canShowMap,
          run: () => this.cycleView(),
        },
        {
          id: 'browser-map',
          group: 'File',
          title: 'Open a contact map on this genome',
          // Still here, and not the same command as the one above it: this
          // browser may have no map behind it at all, in which case opening one
          // is the only way to get one.
          hint: 'Or drop a .cool anywhere on the tracks; the tracks come with it.',
          run: () => this.host.openFileDialog(this),
        },
      ]
    }
    return [
      {
        id: 'find',
        group: 'Go',
        title: 'Find',
        // Every view of a map has exactly one box you type a name into — the
        // region box on a heatmap, the search field above a table — and `/` is
        // where a reader's hand goes to reach it. It used to be the browser's
        // alone, so the same key that found a gene one moment did nothing at all
        // the moment a `.cool` was dropped on the same tab.
        hint: this.searchNoun(),
        keys: KEYS.find,
        enabled: this.current?.focusSearch !== undefined,
        run: () => this.current?.focusSearch?.(),
      },
      {
        id: 'add-map',
        group: 'File',
        title: 'Add a map beside this one',
        hint:
          'Another file, in a panel of its own, navigating with this one (§16). Both maps show ' +
          'the same region at their own bin size — side by side is a weaker claim than the ' +
          'lower-left triangle, so it takes no matching grid.',
        enabled:
          file !== null && parseMaps(state?.maps).length + 1 < MAX_PANELS && this.deckIsPossible,
        run: () => this.addMap(),
      },
      {
        id: 'hide-map',
        group: 'View',
        title: this.mapOnly ? 'The map and its tracks' : 'Read this genome as tracks',
        hint: this.mapOnly
          ? 'Puts the tracks back beside the map. Nothing was hidden while they were away.'
          : 'Takes the matrix out of the picture and lays its chromosomes end to end. The map ' +
            'stays open, and the same key comes back to it.',
        keys: KEYS.mapToggle,
        enabled: this.canHideMap,
        run: () => this.cycleView(),
      },
      {
        id: 'map-export',
        group: 'File',
        title: 'Save this plot as a figure',
        hint: 'The Export card decides the format and the resolution; this is its button.',
        keys: KEYS.savePlot,
        enabled: this.current?.panel !== undefined,
        run: () => this.current?.panel?.savePlot(),
      },
      {
        id: 'map-copy',
        group: 'File',
        // The key means "copy the figure", and with a deck up the figure is the
        // deck: six maps are on screen because the reader arranged six, and
        // handing back the first cell of the arrangement is answering a question
        // they did not ask. One command rather than two, because there is only
        // ever one picture in front of them — see `PanelDeck.copyDeck`.
        title: this.deck === null ? 'Copy this plot to the clipboard' : 'Copy the deck to the clipboard',
        hint:
          this.deck === null
            ? 'The figure as a PNG, at the Export card\'s resolution, ready to paste. With text ' +
              'selected the same key still copies the text.'
            : 'Every panel as one PNG, laid out as it is on screen, ready to paste. With text ' +
              'selected the same key still copies the text.',
        keys: KEYS.copyPlot,
        yieldsToText: true,
        enabled: this.current?.panel !== undefined || this.deck !== null,
        run: () => {
          const deck = this.deck
          if (deck !== null) void deck.copyDeck()
          else this.current?.panel?.copyPlot()
        },
      },
      {
        id: 'fit-tracks',
        group: 'View',
        title: 'Stretch the tracks to fill the height',
        // The same key as in the browser, and for the same reason the autoscale
        // below it shares one: the lanes beside a map and the stack under a
        // browser are one set of tracks, and a key that stopped working the
        // moment a `.cool` was dropped would be saying otherwise.
        hint: 'One height for every lane on both edges, sharing the room the map leaves.',
        keys: KEYS.stretch,
        enabled: this.current?.panel !== undefined && this.annotations !== null,
        run: () => this.current?.panel?.fitTracks(),
      },
      {
        id: 'shrink-tracks',
        group: 'View',
        title: 'Shrink the tracks to the shortest of them',
        hint: 'One height for every lane on both edges, and that height the smallest on screen.',
        enabled: this.current?.panel !== undefined && this.annotations !== null,
        run: () => this.current?.panel?.shrinkTracks(),
      },
      {
        id: 'map-autoscale',
        group: 'View',
        title: 'Autoscale every track',
        // The same key as in the browser, because it is the same act on the same
        // tracks: the lanes beside a map and the stack under a browser are one
        // store, and a key that worked in one of the two would be a key that
        // stopped working when a `.cool` was dropped.
        hint: 'Hand every value axis back to what is in view; a group resolves as a group.',
        keys: KEYS.autoscale,
        enabled: this.current?.panel !== undefined && this.annotations !== null,
        run: () => this.current?.panel?.autoscaleTracks(),
      },
      {
        // One command and one key for the file's own landing table, whichever
        // of the two it is: a metacool's genomes, or an scool's cells. No file
        // has both, so a second entry would be a second key that is disabled on
        // every file the first one works on.
        id: 'go-genomes',
        group: 'Go',
        title: isScool ? 'Cells table' : 'Genomes table',
        keys: KEYS.genomes,
        enabled: file !== null && (isMetacool || isScool),
        run: () => {
          if (state !== null) {
            this.navigate({ uri: state.uri, view: isScool ? 'cells' : 'genomes' })
          }
        },
      },
      {
        id: 'go-contigs',
        group: 'Go',
        title: 'Contigs table',
        keys: KEYS.contigs,
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
          : 'One bounded read. It asks first when the block is large, and is refused if it would not fit this machine.',
        keys: KEYS.whole,
        enabled: file !== null,
        run: () => {
          if (state !== null) {
            this.navigate({ uri: state.uri, view: isMetacool ? 'overview' : 'whole' })
          }
        },
      },
      {
        id: 'go-prev',
        group: 'Go',
        title: 'Previous genome or contig',
        hint: this.stepTarget(-1) ?? undefined,
        keys: KEYS.previous,
        enabled: this.stepTarget(-1) !== null,
        run: () => this.step(-1),
      },
      {
        id: 'go-next',
        group: 'Go',
        title: 'Next genome or contig',
        hint: this.stepTarget(1) ?? undefined,
        keys: KEYS.next,
        enabled: this.stepTarget(1) !== null,
        run: () => this.step(1),
      },
    ]
  }

  /**
   * What `/` reaches, in the view that is mounted.
   *
   * Written per view rather than as one sentence covering all of them, because
   * the boxes genuinely differ: a table's filters the rows in front of you, a
   * heatmap's opens something else. A palette entry that said "the search box"
   * would be true and useless.
   */
  private searchNoun(): string {
    const state = this.store.state
    const view = state?.view
    if (view === 'genomes' || view === 'contigs') return 'The filter above the table.'
    // A gene model beside the map makes the box a *third* thing, and one worth
    // saying: a whole-genome view is three pixels per chromosome arm, so
    // "go to MYC" is a question only typing can ask there.
    const genes = this.annotations?.store.searchSource() !== null && this.annotations !== null
    if (view === 'region') {
      return genes
        ? 'The region box, which is also this view’s title — a contig, a range, or a gene name.'
        : 'The region box, which is also this view’s title.'
    }
    // Two boxes wear the same view kind: the scan's takes a genome, and the
    // `bin × bin` level is `WholeView`, whose box takes a contig and a range in
    // one. Told apart by the level, which is what the shell routes on.
    if (view === 'overview' && state !== null && overviewLevel(state) !== 'bin') {
      return 'Name a genome of this file, or one of its contigs.'
    }
    return genes
      ? 'Name a contig, a range within one, or a gene from the starred model.'
      : 'Name a contig, or a range within one, and open it.'
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
      previous: this.computeStepTarget(-1) ?? this.browserStepTarget(-1),
      next: this.computeStepTarget(1) ?? this.browserStepTarget(1),
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

  /**
   * The same two keys, in the 1D browser.
   *
   * Its sequences are the **assembly's**, not a contigs table's — a browser
   * session has no map and often no cooler at all — but the gesture is the one
   * the map has: `[` and `]` walk the file's own order, one sequence at a time.
   * Leaving them unbound there made the browser the one view where the plainest
   * thing anybody does with a genome had to go through the locus box.
   *
   * A browser with no locus is showing the whole assembly, where "the next
   * sequence" is a step out of a picture that already holds all of them; it
   * steps to the first (or last) instead of refusing, which is what a reader
   * pressing a key that means "along" is asking for.
   */
  private browserStepTarget(delta: number): string | null {
    const state = this.store.state
    const assembly = this.assembly
    if (state === null || state.view !== 'browser' || assembly === null) return null
    const names = assembly.contigs.map((contig) => contig.name)
    if (names.length === 0) return null
    const here = state.locus === undefined ? null : parseLocus(state.locus, assembly)
    // `'whole'` is the whole assembly, which is the same "nowhere in particular"
    // an absent locus is: both step to an end rather than to a neighbour.
    const current = here === null || here === 'whole' ? null : here.contig
    if (current === null) return delta < 0 ? names[names.length - 1] : names[0]
    return neighbour(names, current, delta)
  }

  private step(delta: number): void {
    const state = this.store.state
    const target = this.stepTarget(delta)
    if (state === null || target === null) return
    if (state.view === 'browser') this.navigate({ ...state, locus: target })
    else if (state.view === 'genome') this.navigate({ uri: state.uri, view: 'genome', genome: target })
    else this.navigate({ ...state, region: target })
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
   * The bytes for a URI that arrived in a view state, or `null` for the picker.
   *
   * The one place `render` asks. A remote URL is answered synchronously and
   * costs nothing, which keeps every demo, every published session and every
   * shared link on exactly the path they were on before this existed; only a
   * local name reaches storage.
   *
   * **No `prompt`.** Rendering is not a gesture — the boot path reaches here
   * through `App.restore` → `activate` → `render` with no activation at all —
   * and asking for permission without it resolves without ever showing a
   * dialog. So this asks whether the grant is *already* good; re-granting one
   * that has lapsed is a click's work, and the picker's note is where the click
   * lives.
   */
  /**
   * Write down the grant behind a local file, so a reload can reopen it.
   *
   * Called where a file is **opened**, not where it arrives. A reader who drags
   * a folder onto the window and opens one file out of it has chosen to look at
   * one file; recording the other nine would be keeping a list of everything
   * they ever dragged, which is not what they asked for and not what §11
   * promises.
   *
   * Fire and forget, on both counts. There is no grant at all in Firefox and
   * Safari, and where there is one the reader is waiting on a map rather than on
   * storage — a failed write costs them the *memory* of this file and nothing
   * about the file itself.
   */
  private noteGrant(uri: string, source: SourceSpec): void {
    if (source.kind !== 'local') return
    void grantFor(source.file).then(
      (handle) => {
        if (handle !== null) void rememberHandle(uri, handle, source.file)
      },
      () => undefined,
    )
  }

  private async sourceFor(uri: string): Promise<SourceSpec | null> {
    const remote = inferSource(uri)
    if (remote !== null) return remote
    this.resolving = uri
    try {
      return await resolveSource(uri)
    } finally {
      this.resolving = null
    }
  }

  /** The worker, built the first time anything needs one. */
  private clientOf(): ReaderClient {
    if (this.reader === null) {
      this.reader = new ReaderClient()
      this.reader.onNotice = (done, total, note) => this.notice(done, total, note)
    }
    return this.reader
  }

  /**
   * News from a read nobody asked to follow — onto the veil that is already up.
   *
   * The views raise the veil themselves when they ask for a block and drop it
   * when the block arrives, so this only ever writes on a veil that is up and
   * never leaves one behind: the view's own `setBusy(false)` follows. What it
   * changes is what the veil *says* while a cell set is being summed, which is
   * a wait proportional to the number of cells rather than to the picture.
   */
  private notice(done: number, total: number, note?: string): void {
    const panel = this.current?.panel
    if (panel === undefined) return
    if (note === 'summing cells') {
      panel.setBusy(true, `summing ${fmt.int(done)} of ${fmt.int(total)} cells…`)
      return
    }
    if (note !== undefined) panel.setBusy(true, `${note}…`)
  }

  /**
   * Which of the two things a file is, decided by its name.
   *
   * A guess, and it only has to be right about the *common* cases, because the
   * one it is wrong about costs a wasted open and is then corrected by the bytes
   * — {@link openUnknown} asks the annotations worker what the file actually is
   * and re-routes. Guessing first is what keeps a `.cool` from paying for a
   * second worker and a second read on every open.
   *
   * The table itself is `browse/route.ts`, because a folder view has to make the
   * same judgement — it draws a row per name in a directory nobody has opened,
   * and decides from the name alone whether that row is worth offering. Two
   * copies of these regular expressions is how a `.bedpe` comes to be loadable
   * by dropping and greyed out in a list. This stays as a method because it is
   * the name eleven call sites in this file already use.
   */
  private routeOf(uri: string): FileRoute {
    return routeOf(uri)
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
  /**
   * This whole tab, as a file.
   *
   * Everything the session is: what is on screen, every loaded track with its
   * colour, height, limits and group, the ticked sequences, the hand-placed
   * marks, the table filters, and the overlay preferences the figure was read
   * with. `null` when there is nothing open, which is the one case where a
   * config would describe nothing.
   */
  exportConfig(): SessionConfig | null {
    const state = this.store.state
    if (state === null) return null
    // Which file this is *of*, when it is a local one. A browser session has no
    // `file` and carries its source separately, and both are asked, because a
    // 1D browser opened from a dropped bigWig is as much "made from a file" as a
    // map is. A remote file needs none of this: its identity is its URL.
    const opened = this.file?.source ?? this.assemblySource
    const source =
      opened?.kind === 'local'
        ? {
            name: opened.file.name,
            size: opened.file.size,
            lastModified: opened.file.lastModified,
          }
        : undefined
    return buildConfig({
      state,
      memoryKey: this.memoryKey(state.uri),
      plot: getPlotOptions(),
      // The window's columns, asked of the shell: they are no more this
      // session's than the overlays above are, and both are carried for the same
      // reason — what the sender was looking at includes which columns were out
      // of the way (`ui/SidePanel.ts`'s `PanelState`).
      panels: this.host.panelLayout(),
      now: new Date(),
      ...(source === undefined ? {} : { source }),
    })
  }

  /**
   * Take a config file back, in this tab.
   *
   * The workspace is written into memory *before* the file is opened, because
   * that is where the view reads it from on its way up: the tracks arrive with
   * the picture rather than a gesture later. A remote file opens outright; a
   * local one opens too where this browser still holds a grant for it, and
   * otherwise the session comes up asking, with everything else waiting in
   * {@link pendingConfig} for the moment the file arrives.
   *
   * `prompt` is on because every road here is a gesture — a dropped config, a
   * pasted link, a pressed example — so a permission dialog has the activation
   * it needs and appears where the reader is expecting to be asked for a file.
   */
  async openConfig(config: SessionConfig): Promise<void> {
    setPlotOptions(config.plot)
    this.host.applyPanelLayout(config.panels)
    const source = await resolveSource(config.state.uri, { prompt: true })
    if (this.destroyed) return
    if (source === null) {
      this.pendingConfig = config
      this.showContent(this.pickerWithConfig(config))
      this.host.sessionChanged(this)
      return
    }
    this.pendingConfig = config
    await this.openWithConfig(config.state.uri, source)
  }

  /**
   * Say so, once, when the file handed over is not the file this session was
   * made from.
   *
   * Only where the **name matches**, which is the whole signal: a reader who
   * drops `other.cool` for a session saved from `rep1.cool` has deliberately
   * pointed it somewhere else, and this module's own rule is that the same
   * session under a renamed file is still that session. What is worth remarking
   * on is the case that looks like a match and is not — the same name, different
   * bytes. That is either a re-run pipeline, which is legitimate and which the
   * reader should know about because the numbers on screen are not the numbers in
   * their figure, or it is somebody else's file of the same name.
   *
   * A remark and never a refusal. The two cases are indistinguishable from here,
   * and one of them is a thing people do on purpose.
   */
  private noteSourceMismatch(config: SessionConfig, source: SourceSpec): void {
    const saved = config.source
    if (saved === undefined || source.kind !== 'local') return
    const file = source.file
    if (file.name !== saved.name) return
    const sizeMoved = saved.size !== undefined && saved.size !== file.size
    const timeMoved = saved.lastModified !== undefined && saved.lastModified !== file.lastModified
    if (!sizeMoved && !timeMoved) return
    const was = sourceNote(saved)
    const now = sourceNote({ name: file.name, size: file.size, lastModified: file.lastModified })
    this.host.notify(
      `${file.name} is not the file this session was made from — that one was ${was ?? 'different'}` +
        `, this one is ${now ?? 'different'}. The session has opened; the numbers in it are this ` +
        'file’s.',
    )
  }

  /** Read a dropped file as a config, and say so if it is not one. */
  private async openConfigFile(file: File): Promise<void> {
    // Handed straight up. A saved file is a *workspace* — every tab of the
    // window that wrote it — and seating N tabs is the shell's business; a
    // session has no idea it has neighbours. It also means the refusal is
    // reported in one place rather than in each of the roads a file arrives by.
    this.host.openWorkspaceFile(await file.text(), file.name)
  }

  /**
   * Fetch a session named by URL and open it.
   *
   * The published counterpart of dropping one: the same file, read over the
   * network instead of off a disk, which is what makes a session something you
   * can *link to* rather than only send. It is one plain `GET` — a config is a
   * few kilobytes and there is nothing to range over — and every file it names
   * is then opened by the ordinary paths, so a published session and a dropped
   * one differ in nothing after this line.
   *
   * Relative names inside are resolved against this URL ({@link resolveConfig}),
   * which is what makes a published dataset folder self-contained: the sessions
   * in `demo/yeast/` open from the bucket, from a copy of that folder on another
   * bucket, and in the desktop build, without any of the three being written
   * into the file.
   *
   * **Public for one second caller**, and it is the one this method was already
   * the whole of: `?config=<url>` names a published session in the address
   * itself, which is how an embed is seeded (`src/embed.ts`) and how a session
   * becomes something a page can link to rather than something a reader has to
   * find in a picker. It is the same fetch, the same signing, the same resolving
   * and the same errors — a seeded session and a chosen one differ in nothing
   * after this line, which is the property worth having and the reason there is
   * no second door.
   */
  async openConfigUrl(rawUrl: string): Promise<void> {
    // `?config=` is the other road a URL arrives on — a link, not a box — so the
    // rewrite table runs here the way it runs in `inferSource` for `#uri=`
    // (SPECS §24.5). A workspace published on Drive or named `gs://` is fetched
    // from the address that serves it, and the names inside it are then resolved
    // against that address by `resolveConfig`, which canonicalises them too.
    const url = canonicalUrl(rawUrl)
    this.showContent(loading(`Reading ${fileLabel(url)}`))
    this.host.sessionChanged(this)
    try {
      // Signed when a bucket entry covers it, unsigned otherwise. A published
      // session in a private prefix is the natural way to share a private
      // figure — it names the files beside it, and every one of those is read
      // through the workers, which sign their own requests — so this fetch
      // being the one unsigned link would make the whole arrangement fail at
      // its first step. The static headers ride along by the same argument: a
      // workspace published on a Google host needs the API key its data needs
      // (SPECS §24.7), and a bare link here fails exactly as an unsigned one
      // would.
      const credential = credentialFor(url)
      const response = await fetch(url, {
        headers: accessHeaders({
          url,
          method: 'GET',
          headers: accessHeadersFor(url),
          ...(credential === null ? {} : { credential }),
        }),
      })
      if (!response.ok) {
        throw new Error(
          `${fileLabel(url)} could not be read: the host answered ${response.status} ` +
            `${response.statusText}${credential === null ? '' : ' to a signed request'}.`,
        )
      }
      if (this.destroyed) return
      // …and the same hop for a published one, with the URL it was found at, so
      // the relative names inside it resolve against that folder.
      this.host.openWorkspaceFile(await response.text(), fileLabel(url), url)
    } catch (err) {
      if (!this.destroyed) this.showError(err)
    } finally {
      this.host.sessionChanged(this)
    }
  }

  /**
   * What the picker opens, wherever it is mounted.
   *
   * The landing page and the Open-a-file dialog hand back the same two things,
   * so they go through the same door: a URL naming a *session* is fetched and
   * applied, anything else is a file. Routing one of them past this was how the
   * dialog came to answer a row of the demos store with "this is not a cooler".
   */
  async openPicked(uri: string, source: SourceSpec): Promise<void> {
    await this.openWithConfig(uri, source)
  }

  /**
   * Open a file *as* a config's session: its state, and its workspace.
   *
   * The URI is the one the file is actually opening under, which for a local
   * file is whatever was dropped rather than what the config remembers — the
   * same session under a renamed file is still that session.
   */
  private async openWithConfig(uri: string, source: SourceSpec): Promise<void> {
    // A `.json` on a URL is a session, not a file to open: it is the one thing
    // the picker's box and its store table can be handed that names a whole tab
    // rather than a byte source. Checked before the pending config is
    // consumed, since this *produces* one — and only when there is none, so a
    // session that somehow named another session is refused as a file rather
    // than followed with the first one's workspace silently dropped.
    if (
      this.pendingConfig === null &&
      source.kind === 'remote' &&
      looksLikeConfig(splitUri(uri).path)
    ) {
      await this.openConfigUrl(splitUri(uri).path)
      return
    }
    const config = this.pendingConfig
    this.pendingConfig = null
    if (config === null) {
      await this.open(uri, source)
      return
    }
    this.noteSourceMismatch(config, source)
    applyConfig(config, this.memoryKey(uri))
    // Kept for the one hop `open` can make on its own: a collection addressed
    // at its root lands on one of its entries, under a URI this config has
    // never seen, and the workspace was just written under the root's key.
    this.redirectedConfig = config
    const state = { ...config.state, uri }
    try {
      if (state.view === 'browser') {
        await this.openGenome(uri, source, state.locus, true)
        return
      }
      await this.open(uri, source, state)
    } finally {
      this.redirectedConfig = null
    }
  }

  /**
   * Open a set of files as one session.
   *
   * What a reader means by selecting five files and dropping them is one view
   * with all five in it, and which of them is the *view* is not a question they
   * should have to answer: a contact map wins, because everything else can be
   * drawn beside one; failing that, the first file that names a genome, because
   * the rest are annotations of it. Everything left over is loaded as a track
   * once the view exists, through the same routing a drop onto the tracks takes.
   *
   * The **other** contact maps are the interesting case: they are not tracks and
   * they are not second views, they are the deck (§16). Dropping four replicates
   * is the plainest possible statement of "put these side by side", and it is
   * the gesture the `+` edges and the deck's URL box exist to serve one file at
   * a time.
   *
   * It used to take the second as a *blend* — the lower-left triangle of one
   * square — and discard the third onwards without a word. Both halves of that
   * were wrong. The blend is the strongest claim two files can make and is gated
   * accordingly (one grid, so one bin size, so one chromosome list, §16.4), so
   * the commonest two-cooler drop met a refusal where a deck would simply have
   * worked; and a gesture that silently loses two of the four files a reader
   * selected reads as the application dropping them. The blend is still one
   * click away on the compare card, which is where a claim that strong belongs.
   */
  async openFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    const config = files.find((file) => looksLikeConfig(file.name))
    if (config !== undefined) {
      // A config among the files decides everything, and the rest are what it
      // was asking for: the session it describes, then its own file dropped
      // alongside it, which is exactly the two-step the note asks for done in
      // one gesture.
      await this.openConfigFile(config)
      this.droppedAll(files.filter((file) => file !== config))
      return
    }
    if (files.length === 1) {
      await this.open(files[0].name, { kind: 'local', file: files[0] })
      return
    }
    // Paired *before* a lead is chosen, which matters for exactly one gesture
    // and it is the central one: `reads.bam` and `reads.bam.bai` dropped on an
    // empty window. Choosing the lead from the raw list picks the `.bam`,
    // opens it without its index, and leaves the `.bai` to be routed on its
    // own — a browser on the BAM's reference table, the BAM refused for want of
    // an index, and an orphan row for the index that was right there.
    const paired = pairIndexes(files)
    const maps = files.filter((file) => this.routeOf(file.name) === 'map')
    const leadPair = leadOf(paired, (name) => this.routeOf(name))
    if (leadPair === undefined) return
    const lead = leadPair.file
    await this.open(lead.name, { kind: 'local', file: lead }, undefined, leadPair.index)
    if (this.destroyed) return
    for (const pair of paired) {
      if (pair.file === lead) continue
      // Every spare map, and in the order they were selected — the deck is a
      // list and the reader's order is the only one that means anything.
      if (maps.includes(pair.file)) {
        this.addCompanion(pair.file)
        continue
      }
      this.dropped(pair.file, undefined, undefined, pair.index)
    }
  }

  async open(
    uri: string,
    source: SourceSpec,
    carry?: ViewState,
    index?: File,
    /**
     * How to bin a `.pairs`, on the *second* pass through here.
     *
     * The first open of a contact list is always refused — there is no
     * resolution in the file to open it at — and the refusal is caught below,
     * turned into a dialog, and answered by calling this method again with the
     * reader's choice. The same two-step an `.mcool` at its root already takes.
     */
    binning?: PairsBinning,
  ): Promise<void> {
    if (this.opening === uri) return
    // A file that is not a contact map starts a genome browser instead. Decided
    // by name first, and by the bytes when the name does not say — see
    // {@link routeOf}.
    const route = this.routeOf(uri)
    if (route === 'genome') {
      await this.openGenome(uri, source, carry?.locus, false, index)
      return
    }
    // A sidecar dropped with the file reaches the *map* door too, and two
    // formats use it there. Both are folded into the spec rather than carried
    // alongside it, because the worker builds its sources from the spec alone
    // and a second channel for one format would be a second way for the pairing
    // to be lost (`worker/sources.ts`).
    //
    // A `.px2` beside a `.pairs.gz` is an index: an optimisation, and the file
    // opens without it.
    if (index !== undefined && source.kind === 'local' && source.index === undefined) {
      source = { ...source, index }
    }
    // A bin file beside a HiC-Pro matrix is not. The matrix is half a contact
    // map, so whatever this session already knows about its other half is
    // attached before the worker is asked; what it does not know — a bin file
    // sitting beside a URL — the worker probes for by convention, and refuses by
    // name when there is none (§3.9).
    source = withHicProBins(uri, source, index)
    // The tracks this session is holding, before anything is torn down. A map
    // opened over a genome browser is the same genome by a different file, and
    // the tracks were drawn against it.
    this.carry(uri)
    // …and the second file, on the same terms and for the same reason: a change
    // of resolution is not a change of subject. Taken here, before `this.file`
    // is replaced, because {@link reopeningSameFile} reads it.
    this.carryCompare(uri)
    this.opening = uri
    this.noteGrant(uri, source)
    const client = this.clientOf()
    // A spinner until the worker has something to say, and a bar and a cancel
    // from the first word onward. Only the three indexless containers ever say
    // anything (§3.7, §3.8, §3.9); every other open resolves before the first
    // report. A `.pairs` is *binned* rather than opened, and the heading says
    // so, because the wait is a pass over its records rather than a read.
    let task: Cancellable<OpenResult> | null = null
    const screen = new LoadingView(
      `${binning === undefined ? 'Opening' : 'Binning'} ${fileLabel(uri)}`,
      () => task?.cancel(),
    )
    this.showContent(screen.el)
    this.host.sessionChanged(this)
    try {
      // `pairs/import.ts` weights its pass against the rungs so the bar does
      // not stall at 99%; the other two report bytes and then pixels.
      task = client.cancellable<'open'>(
        { kind: 'open', uri, source, ...(binning === undefined ? {} : { binning }) },
        (done, total, note) => screen.report(done, total, note),
      )
      const info = await task.promise
      const genomes = await client.request<'genomes'>({ kind: 'genomes' })
      if (this.destroyed) return
      // The console's line for the file (§23). Here rather than at the door,
      // because a `.pairs` and an `.mmetacool` both reach that door twice — once
      // to be refused, and again with the answer to the question the refusal
      // asked — and a record written on the way in would carry the URI the
      // reader never got to look at.
      logAction({
        kind: 'open',
        line: `opened ${fileLabel(uri)}`,
        detail: [
          `# file: ${uri}`,
          `# via: ${source.kind}`,
          `# layout: ${info.layout.kind}`,
          ...(binning === undefined
            ? []
            : [`# binned at: ${binning.base} bp, ${binning.rungs} rung${binning.rungs === 1 ? '' : 's'}`]),
        ],
        where: fileLabel(uri),
      })
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
      // A different file, so whatever was parked belongs to a map that is being
      // let go of. `hideMap` is about *this* file and nothing else.
      this.parkedMap = null
      this.file = {
        uri,
        info,
        genomes,
        contigs: null,
        cells: null,
        activeCells: info.cells.length > 0 ? info.activeCells : null,
        source,
        genomeNames: names,
        displayNames: Array.from(genomes.display, (index) => names[index]).filter(
          (name) => name !== UNBINNED_NAME,
        ),
        entries,
        currentEntry,
      }
      const isMetacool = info.layout.kind === 'metacool'
      // An scool's landing table is its cells, and its Genomes entry is greyed
      // out for the reason a cooler's is: every cell holds one genome. What it
      // has instead of genomes is the thing the file is a container of.
      const isScool = info.layout.kind === 'scool'
      this.breadcrumb = new Breadcrumb({
        rootKind: isMetacool ? 'genomes' : isScool ? 'cells' : 'contigs',
        // A metacool offers both landing tables and the scanned whole-genome
        // view. A cooler offers its chromosomes and, when it fits, the whole
        // genome in one read — and still lists Genomes, greyed out, because
        // "this file has none" is a more useful answer than an absent entry.
        rootChoices: isMetacool
          ? ['genomes', 'contigs', 'overview']
          : isScool
            ? ['cells', 'contigs', 'whole']
            : ['genomes', 'contigs', 'whole'],
        ...(isMetacool
          ? {}
          : {
              disabledChoices: isScool
                ? {}
                : {
                    genomes:
                      'A cooler holds one genome, so there is no genomes table — its chromosomes are below.',
                  },
              contigNoun: 'Chromosomes',
            }),
        fileLabel: fileLabel(uri),
        entries,
        entryNoun: info.entryGroup === 'resolutions' ? 'resolution' : 'entry',
        cellCount: info.cells.length,
        ...(currentEntry === undefined ? {} : { currentEntry }),
        onNavigate: (state) => this.navigate(state),
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
      })
      // The same strip the browser shows, over the map's own chromosome list, so
      // "where am I in the genome" is answered in the same place and the same
      // shape whichever picture is on screen. A cooler's `/chroms` table is an
      // assembly; `assemblyOfFile` is the one that says so, and it answers
      // `null` for a file with no contigs, which is a file with no strip.
      const mapAssembly = this.file === null ? null : this.assemblyOfFile(this.file)
      if (mapAssembly !== null) {
        this.buildMinimap(mapAssembly, {
          onOpenContig: (name) => this.navigate({ uri, view: 'region', region: name }),
          onOpenRegion: (region) => this.navigate({ uri, view: 'region', region }),
        })
      } else {
        this.minimap?.destroy()
        this.minimap = null
      }
      this.infoPanel.setMinimap(this.minimap?.el ?? null)
      // Before the sidebar is mounted, so the cards are there on the first paint
      // rather than appearing a frame later.
      await this.setUpAnnotations(uri, info)
      if (this.destroyed) return
      // After it, not before: the card is the `/chroms` table with tick boxes on
      // it, and the read that fills it is the one the annotation gate has just
      // paid for. A metacool never reaches it (see {@link paintSequences}).
      this.paintSequences()
      this.setGeneral([this.infoPanel.el])
      this.host.activity(this)
      // Destroyed, not merely dropped: a scan of the *previous* file may still
      // be running, and the reference going away is not what stops it.
      this.wholeFile?.view.destroy()
      this.wholeFile = null

      // A link may already have named a view inside this file (§5.5); honour it
      // rather than bouncing the recipient to the landing table.
      const rootView: ViewKind =
        info.layout.kind === 'metacool' ? 'genomes' : isScool ? 'cells' : 'contigs'
      const wanted = carry ?? this.store.state
      // `view=browser` is the one view a map session cannot hold: it names the
      // *other* shape of session, and carrying it here would leave the store
      // saying "browser" over an open matrix — which the router then answers by
      // trying to open the genome again. Closing the map is what produces that
      // state, and it does so deliberately (see `closeMap`).
      const wantedTarget =
        wanted !== null && wanted.uri === uri && wanted.view !== 'browser'
          ? wanted
          : landingState(uri, rootView)
      // A carried comparison names the rung it was *at*, and that rung is the
      // one this open has just left. The state is stripped of it here and the
      // second file is re-addressed below, so the reconciliation in `render`
      // does not spend the interval opening a file the gate is about to refuse
      // for having the bin size the reader has just moved away from.
      //
      // `compareCarry` is left standing until {@link restoreCarriedCompare}
      // spends it, because it is also what tells `render` to leave the
      // comparison alone in the meantime — see the note there.
      const carried = this.compareCarry
      const target = carried === null ? wantedTarget : withoutSecond(wantedTarget)
      // Asked of {@link navigate} rather than compared here, because what lands
      // in the store is the target *plus whatever it carried* — so a comparison
      // against the bare target says "this is a move" for a re-drop of the file
      // already open under a deck, and nothing renders at all.
      // Before the navigation, and that is the whole of the ordering: the render
      // it triggers reconciles the comparison against the state, and a second
      // file that is being re-opened must already be *in flight* by then or that
      // reconciliation will start one of its own from this session's memory —
      // which still names the rung the reader has just left.
      if (carried !== null) this.restoreCarriedCompare(carried, uri, info)
      const moved = this.navigate(target, { replace: true })
      // `set` is a no-op when the state is already exactly what arrived, so
      // render explicitly in that case — and only in that case, to avoid
      // mounting the same view twice.
      if (!moved) void this.render(this.store.state)
      // Last, and deliberately not awaited: the map is on screen and usable,
      // and the export is a second job over arrays that are already in memory.
      // Making the reader wait for a file after waiting for a picture is the
      // one thing this ordering exists to avoid.
      // Before the export, because it is about the map that just appeared.
      if (info.pairs !== undefined) reportImportGaps(info.pairs)
      if (info.pairs?.download === true) void this.exportImportedMcool()
    } catch (err) {
      // Cancelling is not a failure and must not look like one. The reader
      // stopped a read they were told the cost of and chose to stop — so the
      // way back is the picker, exactly as dismissing the gate is, and not an
      // error screen about a file that is perfectly fine.
      if (isCancellation(err)) {
        this.opening = null
        this.showContent(this.picker.el)
        this.host.sessionChanged(this)
        return
      }
      // The §12 listing gate is a question, not a failure: a single-cell
      // container over the network cannot be opened without paying one of two
      // costs, and which to pay is the reader's to choose. Asked here rather
      // than in the worker for the obvious reason — the worker has no screen —
      // and re-issued as the *same* open with the answer written on the source.
      // Both §12 load gates land here: an `.scool`'s listing cost and a
      // HiC-Pro pair's parse cost. The second fires on a local file too, which
      // is why this no longer asks whether the source is remote — the gate
      // itself decides when it applies, and reaching here means it has.
      if (isLoadGate(err)) {
        this.opening = null
        const reading = await askLoadCost(err, fileLabel(uri))
        if (this.destroyed) return
        if (reading === null) {
          // Dismissed is an answer: neither cost, so nothing is read. Back to
          // the picker rather than to an error screen about a file that is
          // perfectly fine and simply was not opened.
          this.showContent(this.picker.el)
          this.host.sessionChanged(this)
          return
        }
        await this.open(uri, { ...source, reading }, carry, index)
        return
      }
      // An `.mmetacool` opened at its root is a `KeyError` in Python, and the
      // reader mirrors that faithfully (§3.4). But a *user* who dropped a
      // collection meant "show me this data", so the app answers by opening an
      // entry and offering the rest in the breadcrumb picker, rather than
      // handing back an error about a URI syntax they did not use.
      // A contact list, refused because it declares no resolution. The reader
      // meant "show me this data", so the app asks the one question the file
      // cannot answer and opens again — the same shape as the collection-root
      // redirect below, and for the same reason.
      const probe = pairsProbe(err)
      if (probe !== null) {
        this.opening = null
        openPairsDialog({
          probe,
          fileLabel: fileLabel(uri),
          onConfirm: (chosen) => void this.open(uri, source, carry, index, chosen),
          // Nothing is behind this dialog: dismissing it has to leave the
          // reader somewhere rather than on a blank panel, so the refusal is
          // shown with what it said and the file picker is one press away.
          onCancel: () => this.showError(err, uri, source),
        })
        return
      }
      const landing = firstEntry(err)
      if (landing !== null) {
        const entryUri = `${splitUri(uri).path}::${landing.group}/${landing.entry}`
        // A config being applied has to make the same hop, and it cannot ride
        // along in the state: a workspace is keyed on the *file*, and it was
        // written under the root's key a moment ago. Written again rather than
        // moved, since the root's copy is what a second visit here would read.
        if (this.redirectedConfig !== null) {
          applyConfig(this.redirectedConfig, this.memoryKey(entryUri))
        }
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
      // An open that failed, or was redirected into an entry and handled there,
      // leaves nothing to carry: a note still standing would go on telling
      // `render` that a second file is on its way when nothing is coming.
      this.compareCarry = null
      this.host.sessionChanged(this)
    }
  }

  /**
   * Build and download the `.mcool` for a session opened from a `.pairs`.
   *
   * Runs beside the open map rather than in front of it, with its own bar in
   * the corner and its own cancel, because the reader has already waited once
   * and what they are waiting for now is a file rather than a picture.
   *
   * Failure is reported and nothing else: the map is real and correct whether
   * or not the export succeeded, so a write that runs out of memory must not
   * take the session down with it.
   */
  private async exportImportedMcool(): Promise<void> {
    // The job has to exist before the note can offer to cancel it, and the note
    // has to exist before the job can report into it. Declared first and
    // assigned below, which is the smallest way out of that.
    let job: Cancellable<McoolExport> | null = null
    const note = progressToast('Writing .mcool', () => job?.cancel())
    try {
      const client = this.clientOf()
      job = client.cancellable<'exportMcool'>({ kind: 'exportMcool' }, (done, total, text) =>
        note.update(done, total, text),
      )
      const result = await job.promise
      if (this.destroyed) {
        note.dismiss()
        return
      }
      downloadBlob(new Blob([result.bytes as BlobPart], { type: 'application/x-hdf5' }), result.filename)
      note.finish(`${result.filename} — ${result.rungs.length} resolutions`)
    } catch (err) {
      if (isCancellation(err)) {
        note.dismiss()
        return
      }
      note.fail(`Could not write the .mcool: ${err instanceof Error ? err.message : String(err)}`)
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
    // Hoisted above the `try` and released in the `finally`, as `openGenome`
    // does: the request starts a worker lazily and every failure path here is
    // reachable — an empty file, a truncated header, a fetch that 404s — and a
    // worker that is never terminated is a thread for the life of the page.
    const client = new AnnotationClient()
    try {
      const result = await client.request<'assembly'>({ kind: 'assembly', source: toWire(source) })
      if (result.format === null || result.format === 'hdf5' || result.contigs.length === 0) {
        return false
      }
    } catch {
      return false
    } finally {
      client.destroy()
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
    /**
     * The sidecar dropped alongside, where there was one.
     *
     * Threaded this far because the file that names the genome becomes its own
     * first track, and for a BAM that track cannot open without its index
     * (§8.13). Dropping `reads.bam` and `reads.bam.bai` on an empty window is
     * *the* gesture for this feature, and without this it opened a browser on
     * the BAM's own `@SQ` table and then refused the BAM.
     */
    index?: File,
  ): Promise<void> {
    // `<url>#index=<url>` names the sidecar for a remote file at the one door
    // a URL comes through, and it is split here for the genome road exactly
    // as `AnnotationLoader.addUrl` splits it for a track: the fragment is
    // never sent to a server, and it is the *assembly* question below that a
    // FASTA's `.fai` answers (§8.8). The session goes on under the address.
    if (source.kind === 'remote' && source.index === undefined) {
      const split = splitIndexFragment(source.url)
      if (split.index !== undefined) {
        source = { ...source, url: split.address, index: split.index }
        uri = uri.replace(/#index=.*$/, '')
      }
    }
    if (this.opening === uri) return
    this.opening = uri
    this.noteGrant(uri, source)
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
        // which case the map is opened for its `/chroms` and immediately *put
        // down*. Hidden rather than closed, because `view=browser` on a cooler
        // is a link to the tracks and not an instruction to throw the matrix
        // away: the eye in the Contact maps card brings it straight back.
        client.destroy()
        this.opening = null
        await this.open(uri, source)
        if (insist && !this.destroyed && this.file !== null) {
          await this.contigs().catch(() => null)
          if (this.destroyed) return
          if (this.canHideMap) this.hideMap()
          else this.closeMap()
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
      logAction({
        kind: 'open',
        line: `opened ${fileLabel(uri)} as a genome`,
        detail: [
          `# file: ${uri}`,
          `# via: ${source.kind}`,
          `# format: ${result.format}`,
          `# sequences: ${result.contigs.length}`,
        ],
        where: fileLabel(uri),
      })
      const assembly = assemblyOf({
        uri,
        name: fileLabel(uri),
        contigs: result.contigs,
        origin: result.origin,
      })
      this.carry(uri)
      this.tearDown()
      this.assembly = assembly
      this.assemblySource = source
      this.setUpBrowserAnnotations(assembly)
      // The file that named the genome is also its first track — unless it was a
      // `chrom.sizes`, which declares an assembly and draws nothing.
      // …unless it is already there. `setUpBrowserAnnotations` has just restored
      // whatever this session remembered — a previous visit, or a config file
      // being opened — and that set usually *includes* the file that named the
      // genome. Adding it again gives the same track twice, under one name, with
      // one of the two carrying the settings.
      if (result.format !== 'sizes' && this.annotations !== null && !this.alreadyLoaded(source)) {
        if (source.kind === 'local') {
          // Both halves, so `addFiles` can pair them. One is how a BAM opens a
          // browser on its own reference table and is then refused as a track.
          this.annotations.loader.addFiles(
            index === undefined ? [source.file] : [source.file, index],
          )
        } else {
          // …and the named sidecar goes back on as the fragment `addUrl`
          // splits, so the lane reads the same index the assembly did.
          this.annotations.loader.addUrl(
            source.index === undefined
              ? source.url
              : `${source.url}#index=${encodeURIComponent(source.index)}`,
          )
        }
      }
      const target: ViewState = {
        uri,
        view: 'browser',
        ...(locus === undefined ? {} : { locus }),
      }
      const willNotify = !viewStateEquals(target, this.store.state)
      this.navigate(target, { replace: true })
      if (!willNotify) void this.render(target)
    } catch (err) {
      client.destroy()
      if (!this.destroyed) this.showError(err, uri, source)
    } finally {
      this.opening = null
      this.host.sessionChanged(this)
    }
  }

  /** `true` when a row for this exact file is already in the store. */
  private alreadyLoaded(source: SourceSpec): boolean {
    const rows = this.annotations?.store.entries ?? []
    return rows.some((entry) => {
      // Only rows that came from a file. The 4C profile is a lane in the same
      // store with a name and no bytes behind it, and a file that happened to
      // be called the same thing is not "already loaded".
      if (entry.source.kind === 'derived') return false
      if (entry.source.kind === 'remote') {
        return source.kind === 'remote' && entry.source.url === source.url
      }
      const name = source.kind === 'local' ? source.file.name : source.url.split('/').pop()
      return entry.source.name === name
    })
  }

  /**
   * How the Manual annotations card reaches whatever picture is on screen
   * (§8.1).
   *
   * One picker for both shapes of session, because there is one card and one
   * store behind it: a session walks map → tracks → map without either being
   * rebuilt, and two pickers would be two answers to "what can be pointed at
   * now". That is the bug this replaced — the card was armed against a
   * `MatrixPanel`, which a 1D view does not have, so in the browser every pick
   * button sat disabled with nothing on screen to say why.
   *
   * **Everything mounted, not only the lead.** A mark is a coordinate and a
   * companion is a map, so a deck of five pictures is five places a reader may
   * reasonably point at — and the marks already appeared on all of them, because
   * they live in one store every panel draws from. Only the *gesture* was the
   * lead's, which made the feature look broken in exactly the layout it is most
   * useful in: a domain boundary drawn across four replicates is the thing a
   * deck is for. `armAll` is what makes the several into one mode, and the
   * browser joins that list on the same terms — its picks carry one axis rather
   * than two, which is a fact about the gesture and not about the arming, so
   * nothing here has to know it.
   */
  private markPicker(): MapPicker {
    return {
      // The *mounted* view, and deliberately not "anything `armAll` would
      // reach": a deck outlives a navigation to a table, and a card that lit its
      // buttons there would be offering a gesture on a picture that is not on
      // screen. Which is the same rule as before, with the browser added to it.
      available: () => this.current?.panel !== undefined || this.browser !== null,
      // What the reader would be pointing at, which is what the card's buttons
      // call themselves. A mounted map wins where there is one: a browser is
      // never on screen at the same time as the matrix it stands in front of.
      surface: () => (this.current?.panel === undefined ? 'track' : 'map'),
      start: (handlers, onEnd) => armAll(this.pickTargets(), handlers, onEnd),
    }
  }

  /** Every surface a mark could be placed on as things stand. */
  private pickTargets(): Array<Armable<PickHandlers> | null | undefined> {
    return [this.current?.panel, this.deck, this.browser]
  }

  /**
   * The annotation machinery for a browser session.
   *
   * The same four pieces a map gets, against the assembly rather than against a
   * contigs table — which is the only difference, and it is one lookup: the
   * §8.2 overlap report and the per-contig lengths both come from the assembly's
   * own list. A track therefore behaves identically in both, and a session that
   * later opens a map keeps nothing from here, because the map has its own —
   * except the rows themselves, which cross live rather than through storage
   * (see {@link adoptCarried}).
   */
  private setUpBrowserAnnotations(assembly: Assembly): void {
    const scope = this.memoryKey(assembly.uri)
    // A new genome is a new set of sequence names; a locus picked from the last
    // one would name a place this one has never heard of. See `setUpAnnotations`.
    resetPick()
    const store = new AnnotationStore(scope)
    // The durable workspace is rebuilt from session memory, and almost nothing
    // that fills it is a *navigation*: eight tracks, a mark, a bookmark, a
    // filter. Without this the record would be the session as it stood at the
    // last time the view state moved, and a reader who spent ten minutes
    // arranging tracks and then closed the window would get none of it back.
    // The write itself is debounced, so a track landing costs no more than the
    // colour slider already does.
    store.subscribe(() => this.host.sessionChanged(this))
    const manual = new ManualStore(scope)
    const client = new AnnotationClient()
    const lengths = new Map(assembly.contigs.map((contig) => [contig.name, contig.length]))
    // An assembly's contigs are already `{ name, length }`, which is what the
    // loader's rename wants (§5.9).
    const loader = new AnnotationLoader(store, client, assembly.contigs, (files) =>
      this.considerLengths(files),
    )
    // A new store means the workspace that was watching the old one is stale.
    // `SyntheticCard` subscribes to the store it was *built* with, while
    // `adopt` writes through `host.store()` to whichever is current — so a
    // workspace that outlived its store would go on filing results into a list
    // nobody is looking at, which is exactly how the card came to be empty
    // after a task had plainly run. Destroyed here rather than reconciled: a
    // workspace is per-file, and so is a store.
    this.analysis?.destroy()
    this.analysis = null
    this.syntheticCard = null
    this.annotations = {
      store,
      manual,
      client,
      loader,
      groups: new GroupSettings(scope),
      contigLength: (name) => lengths.get(name),
    }

    this.compareCard = this.newCompareCard(assembly.uri)
    // The marks card, in the place it holds beside a map: under the tracks it
    // annotates. It was absent here, and the store above it was not — so a
    // browser session read a previous visit's marks out of storage, held them in
    // memory and offered no way to see, place or remove any of them. A genome
    // browser is exactly where a reader wants to say *look at this coordinate*:
    // the axis is base pairs, which is what a mark is stated in (§8.1).
    this.manualCard = new ManualCard({
      store: manual,
      picker: this.markPicker(),
      fileLabel: fileLabel(assembly.uri),
    })
    this.setAnnotations([
      this.compareCard.el,
      // Above the Tracks card, not below it: what a reader just computed is what
      // they came back to the panel to find, and a list of eight loaded files
      // between the Run button and its result is a scroll nobody should need.
      this.syntheticSlot,
      new AnnotationCard({
        store,
        loader,
        context: 'browser',
        onPickDropped: (event) => this.pickDropped(event),
      }).el,
      this.manualCard.el,
    ])
    this.setGeneral([this.genomeCardFor(assembly)])
    loader.restore(AnnotationStore.stored(scope))
    // …and what this session was already holding, exactly as the map path does
    // it. Not only for symmetry: `carry` runs before every tear-down and only
    // an adoption clears it, so a browser that ignored the rows would leave
    // them on the session to be adopted by whatever opened *next* — a set of
    // tracks arriving beside a file they were never loaded against.
    this.adoptCarried(loader)
  }

  /**
   * Send the mounted browser somewhere, from a card that is not the browser.
   *
   * The view first and the state after, rather than the state alone: a patch
   * that serialises to what is already stored is dropped without notifying, so
   * clicking a sequence the hash already names would do nothing at all — and
   * the hash names it whenever the last thing to report was a click on that
   * same row. `showLocus` reports on its own, so the address bar still follows.
   */
  private goToLocus(locus: string): void {
    if (this.browser !== null) this.browser.showLocus(locus)
    else this.store.patch({ locus })
  }

  /**
   * Which sequences this session is browsing, made once and shared.
   *
   * One object behind both the Sequences card's tick boxes and the browser's
   * axis, because they are two views of one decision (see `SequenceSelection`).
   * It outlives the `BrowserView`, which is remounted whenever the assembly's
   * lengths are replaced, and it is remembered per session and per file so that
   * a reload comes back to the four chromosomes that were being read rather than
   * to all sixteen.
   *
   * Names the assembly does not have are dropped on the way in: a `chrom.sizes`
   * dropped on a browser can replace the sequence list wholesale, and a stored
   * tick for a sequence that no longer exists would be a restriction the card
   * shows no way to lift.
   */
  private selectionFor(assembly: Assembly): SequenceSelection {
    if (this.sequences !== null) return this.sequences
    const key = this.memoryKey(assembly.uri)
    const known = new Set(assembly.contigs.map((contig) => contig.name))
    const stored = (recall<string[]>(key, 'browser:sequences') ?? []).filter((name) =>
      known.has(name),
    )
    this.sequences = new SequenceSelection(stored, (names) =>
      remember(key, 'browser:sequences', names),
    )
    return this.sequences
  }

  // -------------------------------------------------------------------------
  // The Sequences card, beside a map
  // -------------------------------------------------------------------------

  /**
   * Hang the Sequences card in the General column of a **cooler**.
   *
   * The card that used to be the browser's alone, now the picker a contact map
   * is steered from: no tick is the whole genome, one is that chromosome's
   * block, several are the selection view of them. It replaces the *Chromosome*
   * record card, which could only ever describe the one sequence already named
   * in the breadcrumb — see {@link recordsFor}.
   *
   * **A cooler only.** A metacool's unit is the genome (§5.1) and its contig
   * list is the thousands of pieces those genomes were assembled from; a picker
   * with a hundred thousand tick boxes in it is not a picker, and the genomes
   * table is where that file's selection is made. Its record card stays.
   *
   * Built once per file — the list arrives with the `/chroms` read that
   * {@link setUpAnnotations} already pays for — and never rebuilt: the ticks
   * follow the view through the selection, so rebuilding would only throw away
   * the filter text and the scroll position of a list being read.
   */
  private paintSequences(): void {
    const file = this.file
    const panel = this.infoPanel
    if (file === null || panel === null) return
    if (file.info.hasGenomes) {
      panel.setSequences(null)
      return
    }
    const assembly = this.assemblyOfFile(file)
    if (assembly === null) {
      panel.setSequences(null)
      return
    }
    const selection = this.selectionFor(assembly)
    // One listener per file, and it is this session's rather than the card's:
    // the card is replaced with the file, the selection is not, and a listener
    // left behind would navigate a session that has since opened something else.
    this.sequenceListener?.()
    this.sequenceListener = selection.subscribe(() => this.sequencesChosen())
    panel.setSequences(
      sequenceCard({
        contigs: assembly.contigs,
        selection,
        // The same destination a click on a row of the Chromosomes table
        // reaches, because it is the same act: show me that chromosome.
        onGoTo: (name) => this.navigate({ uri: file.uri, view: 'region', region: name }),
        ...MAP_TICKS,
      }),
    )
  }

  /**
   * A tick changed: draw what is ticked.
   *
   * Silent while the browser is mounted: there the ticks *are* the axis and the
   * browser applies them itself, and while a map is merely parked the state that
   * would be navigated to is the one being kept for its return.
   */
  private sequencesChosen(): void {
    if (this.echoingSequences) return
    const file = this.file
    if (file === null || this.assembly !== null) return
    this.navigate(viewForSequences(file.uri, this.orderedSelection(), this.wholeFileView()))
  }

  /**
   * The ticked names in the file's own order.
   *
   * A selection is drawn in the order it is *given*, so ticking XVI and then I
   * would otherwise put chromosome XVI on the left of the map — a picture of the
   * order the boxes were clicked in rather than of the genome. The card lists
   * them in file order and so does the axis.
   */
  private orderedSelection(): string[] {
    const chosen = new Set(this.sequences?.names ?? [])
    if (chosen.size === 0) return []
    const order = contigPairs(this.file?.contigs ?? null).map(([name]) => name)
    const known = order.filter((name) => chosen.has(name))
    // A name the table does not have cannot be ordered, and dropping it silently
    // would be this method deciding what the reader ticked. There is no such
    // name today — the boxes are built from the table — but the selection is
    // also restored from storage, which is exactly where one would come from.
    return known.length === chosen.size ? known : [...chosen]
  }

  /**
   * Tick whatever the view on screen is a picture of.
   *
   * The other direction of the same binding: the breadcrumb, the Chromosomes
   * table, a pasted link and the back button all move the view without touching
   * a tick box, and a card that said "showing 1 of 16" over a whole-genome map
   * would be the panel disagreeing with the picture beside it.
   *
   * Only on the views that *are* a picture of sequences. A table view leaves the
   * ticks alone rather than clearing them: nothing is drawn there, so there is
   * nothing to disagree with, and clearing would throw away the selection a
   * reader is halfway through making on the way to the map.
   *
   * {@link echoingSequences} is what keeps this from being a loop — the write
   * notifies, and the listener above would answer it with the navigation that
   * caused it.
   */
  private syncSequenceTicks(state: ViewState): void {
    const file = this.file
    const selection = this.sequences
    if (file === null || selection === null || file.info.hasGenomes) return
    // The file's own name column, not a list derived per call: `sequencesShown`
    // resolves through `contigOf`, whose index is held against the array's own
    // identity (§5.9), and a fresh array per render is a fresh whole-table index
    // per render. `contigNames` hands back the column itself.
    const names = this.contigNames() ?? contigPairs(file.contigs).map(([name]) => name)
    const shown = sequencesShown(state, names)
    if (shown === null) return
    this.echoingSequences = true
    try {
      selection.set(shown)
    } finally {
      this.echoingSequences = false
    }
  }

  private mountBrowser(state: ViewState): void {
    const assembly = this.assembly
    const held = this.annotations
    if (assembly === null || held === null) return
    const toggle = this.mapToggleButton()
    const view = new BrowserView({
      assembly,
      store: held.store,
      client: held.client,
      selection: this.selectionFor(assembly),
      ...(state.locus === undefined ? {} : { locus: state.locus }),
      ...(toggle === undefined ? {} : { extraControl: toggle }),
      onLocusChange: (locus) => this.store.patch({ locus }, { replace: true }),
      groups: held.groups,
      // The same store the card writes into and the map draws from. Handed over
      // rather than read back through the session, for the reason the tracks and
      // the groups are: a view is rebuilt on every navigation and a mark is not.
      manual: held.manual,
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
      focusSearch: () => view.focusSearch(),
    })
  }

  /**
   * Files dropped on the content area — in either shape of session.
   *
   * Dropping is *the* gesture this app is opened with, so it works everywhere
   * the file could plausibly be meant for rather than only on the marked
   * rectangle: a sizes file answers a browser's inferred lengths, and anything
   * else joins the tracks. The decision is by name, exactly as {@link routeOf}
   * makes it everywhere else — and a file whose name says nothing is offered to
   * the loader, which reads its bytes and refuses it by name if it is not an
   * annotation.
   *
   * **A contact map dropped on an open session opens *beside* what is there,
   * not instead of it.** It used to replace it, and that was the one route in
   * this app where a drop destroyed something: a track dropped on a map is
   * added to it, a sizes file dropped on a browser replaces one thing and keeps
   * the rest, and a cooler dropped on a map threw away the file, the tracks
   * placed on it, the window and the colour scale — for a gesture that in every
   * other corner of the app means *and this too*. Now it is a companion, which
   * is the same thing the `+` edges and the deck's own URL box do (§16.9), so
   * the three ways of reaching a second map agree.
   *
   * Several at once populate a whole deck, which is what a reader selecting four
   * replicates and dropping them meant. Where there is nothing open to put them
   * beside, the first one still opens the session — that is not a replacement,
   * it is the empty seat being filled — and the rest become its companions once
   * it has landed. They wait, drawn, until the reader opens a view a second map
   * can answer: a genomes table is of *this file* and holds no deck (§16.8), and
   * the maps are in the link from the moment they are dropped.
   *
   * Replacing the open file is still one gesture away and is now the deliberate
   * one it should always have been — the picker, `Open file…`, or a new tab.
   */
  async dropFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    const maps = files.filter(
      (file) => !looksLikeConfig(file.name) && this.routeOf(file.name) === 'map',
    )
    // The empty seat, where there is one. `this.file` and not `deckIsPossible`:
    // a session showing a table, an overview or a refusal has a file open all
    // the same, and dropping a cooler on it must not throw that file away
    // because the view it is currently on cannot hold a second panel.
    const seat = this.file === null && maps.length > 0 ? maps[0] : null
    if (seat !== null) {
      await this.open(seat.name, { kind: 'local', file: seat })
      if (this.destroyed) return
    }
    const rest: File[] = []
    for (const file of files) {
      if (file === seat) continue
      if (maps.includes(file)) {
        this.addCompanion(file)
        continue
      }
      rest.push(file)
    }
    this.droppedAll(rest)
  }

  /**
   * Open one more map beside the one on screen, rather than instead of it.
   *
   * The deck is built if there is none, exactly as the `+` edges and the "add a
   * map" command build one, so all three roads to a second map end in the same
   * place. Refusals — past the backstop, or past what this tab's share of memory
   * will lend — are the deck's own and are said in its bar (`panels/deck.ts`).
   */
  private addCompanion(file: File): void {
    if (this.file === null) return
    // The third road to a second map, and it takes the same refusal as the
    // other two: a metagenome's axis is its own assembly's contigs, so there is
    // no deck for a second one to join ({@link deckIsPossible}). Opened instead,
    // as *this* session's map — the ordinary meaning of dropping a cooler on a
    // viewer that already has one.
    //
    // Not through {@link dropped}, which is what this said and which stopped
    // being true the day that method learned to route a map back here: two
    // metagenomes selected together recursed between the pair until the stack
    // ran out, in the one place where the fallback was supposed to be the calm
    // one.
    if (this.file.info.hasGenomes) {
      void this.open(file.name, { kind: 'local', file })
      return
    }
    this.ensureDeck().add({ kind: 'local', uri: file.name }, { kind: 'local', file })
  }

  /**
   * One file out of a connected folder, however the reader aimed it.
   *
   * The Files panel's `→` and every drop of one of its rows come through here,
   * and it is deliberately thin: it decides *nothing*. A folder hands back where
   * the bytes are, and the two doors that already exist take it from there —
   * {@link dropFiles} and {@link dropped} for a local file, {@link addRemote}
   * for an object on a bucket. A third routing table, written here, is how a
   * `.cool` picked from a folder would come to open somewhere a `.cool` dropped
   * on the window does not.
   *
   * @param placement Which lane stack a *track* should land in, when the drop
   * said so — the map's two edge rectangles. Passed through the routing rather
   * than around it, exactly as a dropped file's is.
   * @param map Which map of a deck the drop landed on, for the same reason.
   */
  /**
   * A row out of the Files panel, dropped somewhere with no aim behind it.
   *
   * The Tracks cards' door, and the reason it takes an event: the payload is
   * readable only while the drop handler runs, and the file behind it arrives a
   * fetch or a permission check later — by which time this session may be gone,
   * which is what `destroyed` is re-checked for.
   */
  pickDropped(event: DragEvent): void {
    void readFileDrag(event).then((picked) => {
      if (picked === null || this.destroyed) return
      void this.addPicked(picked)
    })
  }

  async addPicked(picked: PickedFile, placement?: Placement, map?: string): Promise<void> {
    if (picked.source.kind === 'local') {
      // The sidecar the folder found beside it travels with the file, on both
      // roads. Without it a `.bam` picked from a listing is refused for want of
      // an index that is one row down in the same listing (§8.13).
      const both =
        picked.index === undefined ? [picked.source.file] : [picked.source.file, picked.index]
      // No placement means a drop with no aim behind it — the panel's arrow, or
      // the content area — and that is exactly `dropFiles`'s case, including the
      // empty seat it fills rather than adds to.
      if (placement === undefined && map === undefined) {
        await this.dropFiles(both)
        return
      }
      this.dropped(picked.source.file, placement, map, picked.index)
      return
    }
    await this.addRemote(picked.uri, picked.source, placement, map)
    // A backend that addresses files by id rather than by name says what the
    // file is called (§24.9), and the map is named with it the way a reader
    // would name it by hand (§16.10). Tracks keep the label their URL gives.
    if (picked.name !== undefined && picked.name !== '' && routeOf(picked.uri) === 'map') {
      this.renameMap(picked.uri, picked.name)
    }
  }

  /**
   * {@link dropFiles}, for a file that is somewhere else.
   *
   * The header's `+` offers one box for a URL beside its drop area, and what a
   * reader means by typing into it is what they mean by dropping: *and this
   * too*. So the routing is the same routing — a map goes beside what is open,
   * anything else joins the tracks, and an empty tab is filled rather than added
   * to — and the only thing that differs is where the bytes come from.
   *
   * `source` is carried rather than rebuilt from `uri`, because a file reached
   * through a bucket listing arrives holding that listing's key (§13, and
   * `ui/FilePicker.ts` beside `openPicked`).
   *
   * `placement` and `map` are the aim of a drop, and are absent for every caller
   * that is a box rather than a gesture. They exist because a row in the Files
   * panel can be dragged onto a map's edge exactly as a local file can, and a
   * remote bigWig aimed at the bottom of the third replicate should land there
   * rather than on the lead with the default placement.
   */
  async addRemote(
    uri: string,
    source: SourceSpec,
    placement?: Placement,
    map?: string,
  ): Promise<void> {
    const { path } = splitUri(uri)
    // A saved workspace names whole *tabs* rather than a file to put in one, so
    // it goes to the door that knows that. It keeps this button's promise
    // rather than breaking it: `App.openWorkspaceFile` appends its tabs beside
    // whatever is open, so *and this too* is exactly what a reader gets.
    if (looksLikeConfig(path)) {
      await this.openPicked(uri, source)
      return
    }
    if (this.routeOf(uri) === 'map') {
      // Beside the map that is open, exactly as {@link addCompanion} puts a
      // dropped one, and on the same two conditions: there has to be a map to
      // put it beside, and it has to be one a deck can hold (§16.8). Failing
      // either, it fills the tab — which is the empty seat being taken rather
      // than a replacement.
      //
      // The whole `uri` and not its `path`: `::entries/rep1` names which map
      // inside a collection, and the deck splits the two itself.
      if (this.file !== null && !this.file.info.hasGenomes) {
        this.ensureDeck().add({ kind: 'remote', uri }, source)
        return
      }
      await this.open(uri, source)
      return
    }
    // Everything else is a track on what is here, and the two tabs with nowhere
    // to put one answer exactly as they answer a dropped file: an empty one is
    // filled, and a metacool — which has no annotation machinery at all (§8.5) —
    // does nothing, because there is no coordinate system for a track to be
    // drawn against. This must not open it instead: the promise of the button
    // this arrives from is that it will not throw the open file away.
    if (this.annotations === null) {
      if (this.file === null && this.assembly === null) await this.open(uri, source)
      return
    }
    // The same two steps a dropped track takes in {@link dropped}, and they are
    // written out again rather than shared because the two differ in the one
    // line between them: a local track is created from a `File` and a remote one
    // from a URL. What follows — moving what `begin` just made onto the map the
    // drop landed on — is the same, and is only reached when a drag said where.
    const held = this.annotations
    const before = new Set(held.store.entries.map((entry) => entry.id))
    held.loader.addUrl(path, undefined, placement)
    if (map !== undefined && map !== LEAD_MAP) {
      for (const entry of held.store.entries) {
        if (before.has(entry.id)) continue
        held.store.unplaceFrom(entry.id, LEAD_MAP)
        held.store.placeOn(entry.id, map, entry.placement)
      }
    }
  }

  /**
   * @param placement Which lane stack a *track* should land in, when the drop
   * said so — the two rectangles on the map's own edges. Everything else about
   * the file is decided the same way wherever it was dropped, so this is passed
   * through the routing rather than around it: a `.cool` aimed at the bottom of
   * the map is still a map, not a track drawn along the bottom.
   */
  /**
   * Route a whole drop, having first paired each sidecar with what it indexes.
   *
   * The pairing has to happen *here*, before anything is routed, and that is
   * the whole reason this exists. `dropped` decides what one file is — a
   * workspace, a map, a `chrom.sizes`, a track — and it can only be asked about
   * one file at a time; but a sidecar is not a file *about* itself, it is half
   * of a pair, and every caller was looping `dropped` over the batch and so
   * handing the loader one file at a time. `AnnotationLoader.addFiles` pairs
   * what it is given, and it was never given both.
   *
   * That was a live bug for `.tbi` before a BAM existed: dropping a bgzipped
   * GTF and its index together read the GTF whole and drew the `.tbi` as a
   * refused row. For a BAM it would not be a slow path but a broken one, since
   * there is no whole-file fallback to land in (§8.13).
   *
   * A sidecar whose file is *not* in the batch is passed through untouched, so
   * it reaches the loader alone and is refused by name — which is more use than
   * silently doing nothing.
   */
  private droppedAll(files: readonly File[], placement?: Placement, map?: string): void {
    for (const { file, index } of pairIndexes(files)) this.dropped(file, placement, map, index)
  }

  private dropped(file: File, placement?: Placement, map?: string, index?: File): void {
    // A saved workspace, before anything else looks at it: it is not a track,
    // it is the window it was saved from.
    if (looksLikeConfig(file.name)) {
      void this.openConfigFile(file)
      return
    }
    // A map, dropped somewhere {@link dropFiles} did not route: the map's own
    // lane rectangles, and a config's "and here is the file it describes". It
    // still goes beside what is open rather than over it — a `.cool` aimed at
    // the bottom edge of the map is a map and not a track drawn along the
    // bottom, and it is not a reason to throw the map away either.
    if (this.routeOf(file.name) === 'map') {
      if (this.file !== null) this.addCompanion(file)
      else void this.open(file.name, { kind: 'local', file })
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
    // A metacool carries no annotations (§8.5) and has no assembly to replace,
    // so there is nothing a dropped track could join.
    if (held === null) return
    const before = new Set(held.store.entries.map((entry) => entry.id))
    // The loader raises {@link considerLengths} for every file it is handed, so
    // the "does this file also know the real lengths" question is asked from
    // here without being asked *here* — see the hook's own comment for why it
    // is not a line at this call site.
    held.loader.addFiles(index === undefined ? [file] : [file, index], placement)
    // Everything `begin` just created belongs to the map it was dropped on. The
    // import itself is the session's, as it always was — only the placement
    // moves, so the track is in the one list with every other and simply drawn
    // somewhere other than cell 0.
    if (map !== undefined && map !== LEAD_MAP) {
      for (const entry of held.store.entries) {
        if (before.has(entry.id)) continue
        held.store.unplaceFrom(entry.id, LEAD_MAP)
        held.store.placeOn(entry.id, map, entry.placement)
      }
    }
  }

  /**
   * Take this browser's sequence lengths from a `chrom.sizes` instead.
   *
   * The case it exists for is a browser opened on a BED or a GTF, whose
   * sequences end at their last feature because that is all such a file knows.
   * Dropping the assembly's own sizes replaces the guesses with the lengths
   * ({@link takeLengths}), and this is the one road on which that happens
   * *instead of* loading the file: a `chrom.sizes` is not a track, so there is
   * no lane to make and nothing else for the drop to mean. Every other file
   * that knows its lengths — a bigWig, a BAM, a VCF with `##contig` lines — is
   * a track first and answers this question as well, on {@link
   * adoptExactLengths}.
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
        this.annotations?.loader.addFiles([file])
        return
      }
      this.takeLengths(assembly, result.contigs, 'sizes')
    } catch (err) {
      if (!this.destroyed) this.showError(err)
    } finally {
      client.destroy()
    }
  }

  /**
   * Every file the loader was handed, asked whether it knows the real lengths.
   *
   * The gate rather than the work: this is called on **every** file that reaches
   * a loader by any road, so the cheap check belongs here and the expensive one
   * — a second read of the file, in a worker of its own — belongs behind it.
   * Once the assembly's lengths are exact there is nothing left to improve, and
   * `lengthsAreExact` says so without touching a byte, which is what keeps a
   * reader who drops forty bigWigs onto a browser that already knows its genome
   * from paying for forty pointless reads.
   *
   * Every file rather than the first: a reader selecting a bigWig and a BED
   * together should get the lengths out of whichever of them has them, and
   * `adoptExactLengths` already settles a race between two answers by checking
   * that the assembly it started from is still the one in place.
   */
  private considerLengths(files: readonly File[]): void {
    if (this.assembly === null || lengthsAreExact(this.assembly)) return
    for (const file of files) void this.adoptExactLengths(file)
  }

  /**
   * Take the lengths from a file that was dropped to be a *track*.
   *
   * The other half of {@link adoptSizes}, and the half the Genome card was
   * already promising: a bigWig, a bigBed, a BAM, a FASTA or a VCF that
   * declares its contigs answers "how long is each sequence" exactly, and a
   * browser opened on a GTF is asking. {@link replacesLengths} is the whole of
   * the decision — inferred lengths in, exact lengths out, never the reverse —
   * so this cannot downgrade an assembly and cannot let two exact files fight
   * over one axis.
   *
   * The track is already loading when this is called and this never touches it:
   * the file is a lane, and its header being a `chrom.sizes` too is a second
   * thing about it, not an alternative to being drawn.
   *
   * Its own client rather than `annotations.client`, which is the thread that is
   * at this moment parsing the same file as a track: a worker handles one
   * message at a time, so asking there would put the extra read *in front of*
   * the lane the reader is waiting for. Errors are swallowed rather than shown,
   * because the file's real answer — it opened, or it did not — is the loader's
   * to report, and a second failure notice for the same drop describes a
   * question the reader never asked.
   */
  private async adoptExactLengths(file: File): Promise<void> {
    const assembly = this.assembly
    if (assembly === null || lengthsAreExact(assembly)) return
    const client = new AnnotationClient()
    try {
      const result = await client.request<'assembly'>({
        kind: 'assembly',
        source: { kind: 'local', file, name: file.name },
      })
      // Re-checked after the await, not only before it: two files dropped
      // together are two of these in flight, and the second must not overwrite
      // what the first just settled. `this.assembly !== assembly` is what says
      // so — `takeLengths` replaces the object, so the loser sees a stranger.
      if (this.destroyed || this.assembly !== assembly) return
      if (!replacesLengths(assembly, result)) return
      this.takeLengths(assembly, result.contigs, result.origin)
    } catch {
      // Deliberately silent; see above.
    } finally {
      client.destroy()
    }
  }

  /**
   * Put real lengths under a browser that had guessed ones.
   *
   * Replaces *only* those: the URI, the name, the session memory and every
   * loaded track are what they were, because the genome did not change, only
   * what is known about it. The origin comes from the file that answered so the
   * Genome card names it truthfully — "from the bigWig header" is a different
   * claim from "declared by a chrom.sizes", and both are different from the
   * guess they replace.
   */
  private takeLengths(previous: Assembly, contigs: Contig[], origin: AssemblyOrigin): void {
    this.assembly = assemblyOf({
      uri: previous.uri,
      name: previous.name,
      contigs,
      origin,
    })
    this.setGeneral([this.genomeCardFor(this.assembly)])
    const state = this.store.state
    if (state === null) return
    // Rebuilt rather than told: an assembly is what a `BrowserView` is a view
    // *of*, and its axis is built once from it.
    this.mounted = state
    this.mountBrowser(state)
  }

  /** Whether the map behind this browser can be brought back. */
  get canShowMap(): boolean {
    return this.parkedMap !== null && this.file !== null
  }

  /**
   * Whether the map on screen can be put down without being unloaded.
   *
   * Three conditions, and each is a way the browser would come up empty rather
   * than a preference. A metacool has no annotation machinery at all (§8.5), so
   * there is no 1D browser to fall back to; a file whose contigs have not been
   * read yet has no assembly to build; and a session that is already browsing
   * has nothing to put down.
   */
  get canHideMap(): boolean {
    return (
      this.file !== null &&
      this.assembly === null &&
      this.annotations !== null &&
      contigPairs(this.file.contigs).length > 0
    )
  }

  /**
   * The assembly a cooler's own chromosome list makes.
   *
   * One derivation, used by both doors out of a map: `closeMap` builds the
   * genome it falls back to, and {@link hideMap} builds the same one. Two copies
   * would be two answers to "what genome is this file of".
   */
  private assemblyOfFile(file: OpenFile): Assembly | null {
    const contigs = contigPairs(file.contigs)
    if (contigs.length === 0) return null
    return assemblyOf({
      uri: file.uri,
      name: fileLabel(file.uri),
      contigs: contigs.map(([name, length]) => ({ name, length })),
      origin: 'cooler',
    })
  }

  /**
   * Put the map down without letting go of it.
   *
   * The reversible door, and the one the eye in the Contact maps card opens.
   * Everything {@link closeMap} tears down stays: the worker keeps the file
   * open, the breadcrumb and the File card keep their DOM, a comparison keeps
   * its second reader. Only what is *mounted* changes, and the tracks do not
   * even notice — they are the same store drawn against the same genome, which
   * is the whole reason a map and a browser were ever one session.
   *
   * A map is a thing laid over a genome, like the tracks beside it; hiding one
   * should cost no more than hiding the other.
   */
  private hideMap(): void {
    const file = this.file
    const state = this.store.state
    if (file === null || state === null || !this.canHideMap) return
    // A map put down while its tracks were away comes back with them: the point
    // of the browser is the tracks, so arriving there with none would be the
    // cycle's second stop showing nothing at all.
    this.mapOnly = false
    const assembly = this.assemblyOfFile(file)
    if (assembly === null) return
    this.parkedMap = state
    this.assembly = assembly
    // The browser steers its axis from the Sequences card, which is General's;
    // the Annotations column is untouched, because every card in it — the
    // tracks, the hand-drawn marks, the maps themselves — is about this genome
    // either way.
    // The right-hand stack's tracks are drawn flipped so they grow towards the
    // map; the browser has no map to grow towards, so they are turned back.
    this.annotations?.store.turnAxesForBrowser()
    this.setGeneral([this.genomeCardFor(assembly)])
    this.syncCompareCard()
    // Where the map was looking, carried across as a locus. Read *before* the
    // view is torn down, and read from the panel rather than from the state,
    // because the state names the block that was read and the panel knows the
    // window inside it that a pan and a zoom have since moved to. Absent where
    // the map was on several sequences at once, and then the browser opens on
    // the whole genome — which is that picture's own analogue of a whole map.
    const locus = this.current?.panel?.framedLocus()
    this.mounted = null
    const target: ViewState = {
      uri: file.uri,
      view: 'browser',
      ...(locus === undefined ? {} : { locus }),
    }
    const willNotify = !viewStateEquals(target, this.store.state)
    this.navigate(target)
    if (!willNotify) void this.render(target)
    this.host.sessionChanged(this)
  }

  /**
   * The one key that walks the three pictures a file with tracks can be.
   *
   * **Map and tracks → tracks → map → map and tracks.** Two of those swap what
   * is mounted and the third does not, which is why this is a cycle written in
   * one place rather than a toggle in each of them: a reader pressing `v`
   * repeatedly is asking to see the same data with less and then more furniture
   * around it, and where the boundary between "another view" and "the same view
   * drawn differently" falls is an implementation detail they should never meet.
   *
   * The order is not arbitrary. Tracks-only comes first because it is the one
   * that answers "get this matrix out of my way", which is what a reader with
   * six tracks open wants most often; map-only follows because from there the
   * next thing to ask is the opposite. Three presses come home.
   */
  private cycleView(): void {
    if (this.canShowMap) {
      // Coming back from the browser: the map, and only the map.
      this.mapOnly = true
      this.showMap()
      return
    }
    if (this.mapOnly) {
      this.mapOnly = false
      this.current?.panel?.showLanes(true)
      this.refreshMapToggle()
      this.host.sessionChanged(this)
      return
    }
    this.hideMap()
  }

  /** Bring the parked map back, exactly where it was left. */
  private showMap(): void {
    const target = this.parkedMap
    if (target === null || this.file === null) return
    this.parkedMap = null
    this.assembly = null
    this.browser = null
    // …and turned again on the way back, by the same call: it is a toggle, so
    // the round trip is the identity and a track hung deliberately from its
    // ceiling keeps that decision through both halves of it.
    this.annotations?.store.turnAxesForBrowser()
    // Rebuilt rather than re-parented: a card that leaves the document drops its
    // listener on the selection the first time it is spoken to afterwards (see
    // `sequenceCard`), and every tick made in the browser while the map was down
    // is one of those. The card that comes back has to be a live one.
    this.paintSequences()
    this.setGeneral(this.infoPanel === null ? [] : [this.infoPanel.el])
    this.syncCompareCard()
    this.mounted = null
    const willNotify = !viewStateEquals(target, this.store.state)
    this.navigate(target)
    if (!willNotify) void this.render(target)
    this.host.sessionChanged(this)
  }

  /**
   * The control that swaps the map for the tracks, and back.
   *
   * Built here rather than in the six views that show it, because what it says
   * depends on which of the two is on screen and only the session knows that.
   * `undefined` where the swap is impossible — a browser with no map behind it,
   * a metacool, a file whose contigs have not been read — so a view that gets
   * nothing draws nothing rather than a button that does nothing.
   *
   * The same act as the eye in the Contact maps card, and deliberately two
   * controls: the card is where a reader decides *what is drawn*, and this is
   * where their hand already is when they decide they would rather be reading
   * the other picture.
   */
  private mapToggleButton(): HTMLElement | undefined {
    const node = this.buildMapToggle()
    this.mapSwitch = node ?? null
    return node
  }

  /**
   * Put the button's *current* face on screen, without rebuilding the view.
   *
   * Two of the cycle's three steps mount another view and get a fresh button
   * with it; the third — putting the tracks back beside the map — changes
   * nothing but this panel's furniture, so nothing would have rebuilt the
   * control that had just been pressed. It read `map + tracks` while showing
   * exactly that, which is a button describing the state it is in rather than
   * the one it offers, and only on one of the three steps.
   */
  private refreshMapToggle(): void {
    const held = this.mapSwitch
    if (held === null || !held.isConnected) return
    const next = this.buildMapToggle()
    if (next === undefined) return
    held.replaceWith(next)
    this.mapSwitch = next
  }

  private buildMapToggle(): HTMLElement | undefined {
    // What the button offers is the **next** stop of the cycle, not the one on
    // screen: it is a control rather than a status light, and a reader reads it
    // to find out what pressing it will do. Three stops, three faces.
    if (this.canShowMap) {
      return keyedIconButton('grid-2x2', 'map only', KEYS.mapToggle, () => this.cycleView(), {
        title: withKey(
          'Back to the contact map on its own — it was never unloaded, and neither were the tracks',
          KEYS.mapToggle,
        ),
      })
    }
    if (!this.canHideMap) return undefined
    if (this.mapOnly) {
      return keyedIconButton('layers', 'map + tracks', KEYS.mapToggle, () => this.cycleView(), {
        title: withKey('Put the tracks back beside the map', KEYS.mapToggle),
      })
    }
    return keyedIconButton('chart-line', 'tracks', KEYS.mapToggle, () => this.cycleView(), {
      title: withKey(
        'Read this genome as tracks. The map stays open — the same key comes back to it',
        KEYS.mapToggle,
      ),
    })
  }

  /**
   * The Contact maps card, for either shape of session.
   *
   * One factory and not two, because the card is the same card: it lists the
   * maps this session holds, and a browser started from a bigWig holds none —
   * which is a count rather than a different card. What every callback here
   * reads is the *session*, so the one built for a genome and the one built for
   * a map answer the same questions and answer them from the same place.
   */
  private newCompareCard(uri: string): CompareCard {
    return new CompareCard({
      primaryLabel: () => this.mapLabel(this.file?.uri ?? uri),
      secondLabel: () => (this.compare === null ? undefined : this.mapLabel(this.compare.uri)),
      onRename: (which, name) => {
        const target = which === 1 ? (this.file?.uri ?? uri) : this.compare?.uri
        if (target !== undefined) this.renameMap(target, name)
      },
      hasPrimary: () => this.file !== null,
      onOpen: (source) => {
        // With a map already open this is the *second* file, which is a
        // comparison.
        if (this.file !== null) {
          void this.openCompare(
            source.kind === 'local' ? source.file.name : source.url,
            source.kind === 'local'
              ? { kind: 'local', file: source.file }
              : { kind: 'remote', url: splitUri(source.url).path },
          )
          return
        }
        // With none it is the first, which is this session becoming a map — and
        // the tracks come across live, because a genome browser that opens a map
        // of its own genome has not changed the subject. Through the doors every
        // other drop takes, rather than straight at `open`: what a file *is* is
        // decided in one place, so a saved workspace dropped on this rectangle
        // is still a saved workspace and a `chrom.sizes` is still an answer about
        // lengths.
        if (source.kind === 'local') this.dropped(source.file)
        else void this.openWithConfig(source.url, { kind: 'remote', url: splitUri(source.url).path })
      },
      // With one map open the × is the way out of the matrix altogether — the
      // door `closeMap` opens, which the File card used to carry. With two it
      // means what it has always meant: put this one down and keep the other.
      onClose: (which) => {
        if (which === 1 && this.compare === null) this.closeMap()
        else this.closeCompare(which)
      },
      onToggleShown: (which) => {
        if (which === 1) this.toggleMap()
        else {
          this.compareHidden = !this.compareHidden
          this.syncCompareCard()
          this.remount()
        }
      },
      isShown: (which) => (which === 1 ? this.parkedMap === null : !this.compareHidden),
      onSwap: () => void this.swapCompare(),
    })
  }

  /** Redraw the Contact maps card's eyes from what this session is showing. */
  private syncCompareCard(): void {
    this.compareCard?.sync()
  }

  /** The map's eye, in the card that lists it: hide it, or bring it back. */
  private toggleMap(): void {
    if (this.canShowMap) this.showMap()
    else this.hideMap()
  }

  /** The Sequences card a browser steers its axis from. */
  private genomeCardFor(assembly: Assembly): HTMLElement {
    this.buildMinimap(assembly, {
      // A bare sequence name is already a locus the browser's own parser takes,
      // so a click on a band needs no conversion at all.
      onOpenContig: (name) => this.goToLocus(name),
      onOpenRegion: (region) => this.goToLocus(formatLocus(rangeOfRegion(region))),
    })
    return genomeCard(
      assembly,
      (locus) => this.goToLocus(locus),
      this.selectionFor(assembly),
      this.minimap?.el,
    )
  }

  /**
   * A fresh minimap over this assembly, replacing whatever the last one was of.
   *
   * One card per assembly rather than one per session: the strip is laid out
   * from the sequence list, and a browser that adopts real lengths
   * ({@link takeLengths}) or opens a different genome is a different strip. The
   * old one is destroyed rather than dropped — it holds a `ResizeObserver` and a
   * text-scale subscription, and the column that showed it is about to be
   * replaced wholesale by `setGeneral`, which calls nothing.
   *
   * `null` where a strip would not be a picture of anything: a metagenome is
   * tens of thousands of contigs from thousands of independently assembled
   * organisms, every band a fraction of a pixel, which is the same gate
   * {@link paintSequences} and `ContigsTable` already apply (§7.4).
   */
  private buildMinimap(
    assembly: Assembly,
    go: { onOpenContig: (name: string) => void; onOpenRegion: (region: string) => void },
  ): void {
    this.minimap?.destroy()
    this.minimap = suitsMinimap({ hasGenomes: this.file?.info.hasGenomes ?? false })
      ? new MinimapCard({ assembly, ...go })
      : null
    this.syncMinimap(this.store.state)
  }

  /**
   * Where the minimap should say we are, from the state alone.
   *
   * From the state rather than from the mounted view, because this runs on every
   * navigation including the ones that mount nothing new — a pan reports its
   * locus into the store (`mountBrowser`'s `onLocusChange`), so the store is the
   * one place both a jump and a drag are visible.
   *
   * The two modes differ in exactly one thing and the strip does not know it:
   * a browser has a window and a map has a row range and a column range. Equal
   * ranges are what an on-diagonal block is, and `MinimapCard` collapses them
   * back into the single highlight a 1D window draws — so the same place looks
   * the same in both modes, which is what the card is for.
   */
  private syncMinimap(state: ViewState | null): void {
    const card = this.minimap
    if (card === undefined || card === null) return
    const assembly = this.assembly ?? (this.file === null ? null : this.assemblyOfFile(this.file))
    if (state === null || assembly === null) {
      card.update(null)
      return
    }
    if (state.view === 'browser') {
      const here = state.locus === undefined ? null : parseLocus(state.locus, assembly)
      // `'whole'` is the whole genome, which is the same "nowhere in particular"
      // an absent locus is — and highlighting everything says nothing.
      card.update(
        here === null || here === 'whole' ? null : { kind: 'window', range: here },
      )
      return
    }
    const rows = state.region === undefined ? null : minimapRange(state.region, assembly)
    if (rows === null) {
      card.update(null)
      return
    }
    // An absent `region2` is an on-diagonal block, which is the same range twice
    // rather than a missing one (§5.5).
    const columns = state.region2 === undefined ? rows : minimapRange(state.region2, assembly)
    card.update({ kind: 'block', rows, columns: columns ?? rows })
  }

  /**
   * Close the contact map and keep browsing its genome.
   *
   * The one-way door, beside {@link hideMap}'s reversible one: the worker is put
   * down and the file is let go of. A cooler carries a chromosome list, which is
   * an assembly; there is no reason for closing the map to also throw away the
   * tracks that were drawn beside it. So it does not — the same store, the same
   * rows, the same colours, now along a genome instead of along an axis of bins.
   */
  private closeMap(): void {
    const file = this.file
    if (file === null) return
    this.parkedMap = null
    const assembly = this.assemblyOfFile(file)
    if (assembly === null) {
      this.toPicker()
      return
    }
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
    // The cooler's own, because that is where these lengths came from: a task
    // run after the map is closed is still a measurement of that file, and its
    // record should say so rather than naming a genome with no file behind it.
    this.assemblySource = file.source
    if (held === null) this.setUpBrowserAnnotations(assembly)
    else {
      this.compareCard = this.newCompareCard(assembly.uri)
      this.setAnnotations([
        this.compareCard.el,
        this.syntheticSlot,
        new AnnotationCard({
          store: held.store,
          loader: held.loader,
          context: 'browser',
          onPickDropped: (event) => this.pickDropped(event),
        }).el,
      ])
      this.setGeneral([this.genomeCardFor(assembly)])
    }
    this.mounted = null
    const target: ViewState = { uri: file.uri, view: 'browser' }
    // `set` is a no-op when the state is already exactly this — which it is when
    // a `view=browser` link to a cooler got here by opening the map for its
    // `/chroms` — so render explicitly in that case, and only in that case.
    const willNotify = !viewStateEquals(target, this.store.state)
    this.navigate(target)
    if (!willNotify) void this.render(target)
  }

  /** Everything a session holds for one file, released before it holds another. */
  private tearDown(): void {
    this.parkedMap = null
    // A genome browser replacing a map is a change of subject, whatever the two
    // files are called: nothing here is coming back at another bin size, so the
    // carry is spent before the drop rather than kept for an open that will
    // never happen.
    this.compareCarry = null
    this.annotations?.client.destroy()
    this.annotations = null
    this.manualCard = null
    this.metadataCard = null
    this.bookmarksCard = null
    this.dropCompare()
    this.compareCard = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.file = null
    this.assembly = null
    // Held only so a task can name what it measured, and a `File` is a handle:
    // released with the genome it belonged to rather than kept for the next one.
    this.assemblySource = null
    this.sequenceListener?.()
    this.sequenceListener = null
    this.sequences = null
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
    this.metadataCard = null
    this.bookmarksCard = null
    // A picked locus names a sequence, and the same name in another file is
    // another place: carrying one across would hand a form coordinates from
    // somewhere the reader never pointed at. A module-level fact about which
    // locus was last asked for, and this is the one moment it stops being true.
    resetPick()
    // The comparison belonged to the file that is being replaced. Its worker
    // goes with it — the second map was a second map *of this one*, and there is
    // no sense in which it survives the first being closed.
    this.dropCompare()
    this.compareCard = null

    // The contigs table is what every annotation is matched against — by name,
    // for the §8.2 overlap report, and by length, so an aggregated axis knows
    // how long one cell is. It is read once per file and cached, so this is the
    // only place that pays for it. A metacool reads it too, now: its own
    // columns are what §8.12 draws, and the same table carries them.
    const contigs = await this.contigs().catch(() => null)
    // A live reader request, so the session may have been closed while it was
    // outstanding — and closing it rejects exactly this read. Without the check
    // a destroyed session goes on to build an annotation client, mount cards
    // and `restore()` its remembered rows, which spawns a worker and re-fetches
    // every remote track into a tab that is no longer on screen and holds no
    // reference that could ever put it down again.
    if (this.destroyed) return
    const names = contigNames(contigs)
    const lengths = contigLengths(contigs)
    // Which MAG each sequence belongs to, for the overlap report (§8.5). Empty
    // on a cooler, which has no genome layer to report against.
    const genomeOf = info.hasGenomes
      ? contigGenomes(contigs, this.file?.genomes.table ?? null)
      : new Map<string, string>()

    // What `/bins` holds, by name and kind. A group listing and one dtype per
    // column — no values, so §3.3's rule that `/bins` is never read at open
    // time still holds, and the drop-down can offer the weights a cooler was
    // balanced with (§8.12).
    const binColumns = await this.clientOf()
      .request<'binColumns'>({ kind: 'binColumns' })
      .then((result) => result.columns)
      .catch(() => [])
    if (this.destroyed) return

    const scope = this.memoryKey(uri)
    const store = new AnnotationStore(scope)
    // The durable workspace is rebuilt from session memory, and almost nothing
    // that fills it is a *navigation*: eight tracks, a mark, a bookmark, a
    // filter. Without this the record would be the session as it stood at the
    // last time the view state moved, and a reader who spent ten minutes
    // arranging tracks and then closed the window would get none of it back.
    // The write itself is debounced, so a track landing costs no more than the
    // colour slider already does.
    store.subscribe(() => this.host.sessionChanged(this))
    const manual = new ManualStore(scope)
    const client = new AnnotationClient()
    const loader = new AnnotationLoader(
      store,
      client,
      // Names, lengths **and genomes**. The first two are §5.9's: the loader
      // renames a track's sequences into this map's vocabulary, and a rename
      // with no length behind it is a guess nothing can check. The third is
      // §8.5's: on a metagenome the overlap a reader needs reported is which
      // *MAGs* a file covers, and 412 of 20,566 sequences is a true sentence
      // that reads like a broken file.
      names.map((name) => ({
        name,
        length: lengths.get(name) ?? 0,
        ...(genomeOf.size === 0 ? {} : { genome: genomeOf.get(name) ?? '' }),
      })),
      (files) => this.considerLengths(files),
    )
    // A new store means the workspace that was watching the old one is stale.
    // `SyntheticCard` subscribes to the store it was *built* with, while
    // `adopt` writes through `host.store()` to whichever is current — so a
    // workspace that outlived its store would go on filing results into a list
    // nobody is looking at, which is exactly how the card came to be empty
    // after a task had plainly run. Destroyed here rather than reconciled: a
    // workspace is per-file, and so is a store.
    this.analysis?.destroy()
    this.analysis = null
    this.syntheticCard = null
    this.annotations = {
      store,
      manual,
      client,
      loader,
      groups: new GroupSettings(scope),
      contigLength: (name) => lengths.get(name),
      metadata: metadataIndexFrom({
        // The two tables the app has already read, and the third by name only.
        genomes: info.hasGenomes ? (this.file?.genomes.table ?? null) : null,
        contigs: contigs?.table ?? { columns: [], length: 0, data: {} },
        binsize: info.binsize ?? 1,
        binColumns,
        client: this.clientOf(),
        // A `/bins` slice landing is new data for a lane that is already drawn,
        // and the panels are what have to hear about it — the annotation store
        // did not change, so nothing else would ask for a frame.
        onChange: () => this.repaintMetadata(),
      }),
    }

    this.manualCard = new ManualCard({
      store: manual,
      picker: this.markPicker(),
      fileLabel: fileLabel(uri),
    })
    this.bookmarksCard = new BookmarksCard({
      store: new BookmarkStore(scope),
      go: (mark) => this.goToBookmark(mark),
      available: () => this.current?.panel !== undefined,
      // Read off whatever panel is mounted *now*, not off one captured here: this
      // card is built once per file and the picture under it is rebuilt on every
      // navigation, so a held reference would save the window of a view the reader
      // left ten clicks ago.
      framed: () => this.current?.panel?.framedRegion() ?? null,
      binsize: () => this.file?.info.binsize ?? null,
    })

    // **No second map for a metagenome** (§8.5). A metacool is not compared this
    // way and never has been — `compareRefusal` has always said so — but the
    // card offering it was still the first thing in the column, so the whole of
    // what it did on this file was invite a gesture and then explain that it
    // does not work. An absent card is the doctrine everywhere else here: a
    // control a file cannot answer is not shown greyed, it is not shown.
    this.compareCard = info.hasGenomes ? null : this.newCompareCard(uri)

    // The demo map ships ten annotation files on its own assembly. Offering
    // them as one click is the difference between a viewer that demonstrably
    // works and one a reader has to assemble a test case for — and offering them
    // to a session that is bringing its own tracks back is the opposite of that
    // ({@link demoAnnotationsToOffer}).
    //
    // Asked of **storage** rather than of the store, because the store is empty
    // at this point in the build and the rows are not: `applyConfig` writes an
    // imported session's tracks into the same session memory a reload leaves
    // behind, under the same scope `AnnotationStore.stored` reads, and both
    // happen before this line. So one question answers for an imported
    // workspace, a `?config=` link and a plain reload alike, rather than three
    // flags that would each have to be threaded down here.
    const published = demoAnnotationsToOffer(uri, {
      restoring: AnnotationStore.stored(scope).length > 0,
    })
    // Contact maps first, and that is the change of mind this card's eyes made
    // necessary: while it was only "load a second file to compare against" it
    // belonged under the tracks, as the rarest thing in the column. It is now
    // where a reader goes to *leave* the matrix, which is not a rare thing at
    // all — and a control that turns the whole picture into a genome browser
    // does not belong under eight track rows and a list of hand-drawn marks.
    // The file's own columns (§8.12). It goes **under the tracks and over the
    // marks**, which is the same ordering the column already has: the cards
    // descend from what came out of a file to what a reader put there by hand,
    // and a column of the open map's own tables is the last thing on that side
    // of the line.
    this.metadataCard = new MetadataCard({
      store,
      index: () => this.annotations?.metadata ?? null,
      level: () => this.metadataLevel(),
      maps: () => this.deck?.mapList ?? [{ id: LEAD_MAP, label: fileLabel(this.file?.uri ?? '') }],
      onExport: (entry) => this.exportMetadata(entry),
    })

    // **Every file gets the same column now** (§8.5). It used to fork here: a
    // metacool got the metadata card and nothing else, on §8.5's argument that
    // a bigWig keyed on contig names from thousands of independently assembled
    // organisms either coincides or misleads. The premise was wrong about the
    // files people actually have. A metagenome is *one co-assembly* binned into
    // MAGs afterwards, so its `/contigs` names are one namespace — on the mock
    // community, 20,566 sequences and 20,566 distinct names — and a bigWig of
    // coverage over that assembly is keyed on exactly those names, in exactly
    // the (contig, start, end) coordinates every other lane here is drawn in.
    // What was needed instead of a gate was an honest *report*: which MAGs a
    // file covers, which `overlapWarning` now says.
    this.setAnnotations([
      ...(this.compareCard === null ? [] : [this.compareCard.el]),
      // Above the Tracks card: see the browser path for why.
      this.syntheticSlot,
      new AnnotationCard({
        store,
        loader,
        onPickDropped: (event) => this.pickDropped(event),
        // Every map a track could be drawn on. A session with no deck answers
        // with itself, so the location control keeps the shape it has always
        // had until there is more than one map to choose between.
        maps: () => this.deck?.mapList ?? [{ id: LEAD_MAP, label: fileLabel(this.file?.uri ?? '') }],
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
                    loader.addUrl(entry.url, entry.label)
                  }
                },
              },
            }),
      }).el,
      this.metadataCard.el,
      this.manualCard.el,
      // Under the marks, because the two are the same kind of note made at
      // opposite ends of a gesture: a mark says *look here* on the picture you
      // have, and a bookmark says *take me back* to a picture you had.
      this.bookmarksCard.el,
    ])

    // What a previous visit to this file left in session storage (§8.6). After
    // the cards are mounted, so the restored rows land in a list that exists.
    loader.restore(AnnotationStore.stored(scope))
    // Where the tracks were *drawn*, when the answer is not "on the lead".
    // Seeded rather than placed: the lanes go into the store's parking, and
    // `adoptHome` — which already runs once per render for every live cell —
    // puts each one back the moment a panel opens the file it belongs to. So a
    // companion that comes back gets its tracks, and one that does not leaves
    // them on the lead, which is exactly what closing a cell has always done.
    store.seedHomes(AnnotationStore.storedLanes(scope))
    this.restoreMetadata(scope)
    // …and what this session was already holding, when the file under it has
    // just changed. Dropping a cooler on a genome browser is the case: the
    // tracks were opened against that genome and the map is of the same genome,
    // so throwing them away would be answering "show me the map of this" with
    // "start again". They come across live — the `File` handles are still open —
    // rather than through storage, which would bring them back detached.
    this.adoptCarried(loader)
  }

  /**
   * Tracks held by the outgoing file, taken over by the incoming one.
   *
   * Held on the session across the tear-down between the two, since that is the
   * only moment when neither store exists. Memory is keyed on the *file*, so
   * nothing arrives on its own: without this the rows are still in storage under
   * the old URI and the new store opens empty.
   */
  private carried: AnnotationEntry[] | null = null
  /**
   * Which map each carried row was drawn on, snapshotted with the rows.
   *
   * Held **apart from the rows**, because a lane is not a property of a track:
   * one import can be on three maps of a deck and on none, and an entry carries
   * only the placement it defaults to (`annotations/placement.ts`). Without this
   * the whole deck's arrangement was thrown away on every reopen — and not
   * silently: `AnnotationStore.begin` places every row it is handed on the lead,
   * which is right for an import and wrong for a row coming *back*, so a change
   * of resolution collected every companion's tracks onto the first map.
   */
  private carriedLanes: readonly Lane[] | null = null

  /**
   * What the analysis workspace had computed, when the file is only changing
   * resolution.
   *
   * Held on the session for the same reason and across the same gap as
   * {@link carried}, and separately from it because the two travel by different
   * roads: a loaded track goes back in through the `AnnotationLoader`, which
   * re-reads it from the handle it still holds, and a computed one has no handle
   * — its numbers are in the workspace, and only a workspace can put them back.
   */
  private carriedAnalysis: readonly CarriedResult[] | null = null

  /**
   * The reader's own marks, held across the same gap for the same reason.
   *
   * Apart from {@link carried} because they arrive by a different road: a track
   * goes back in through the `AnnotationLoader`, which re-reads it from the
   * handle it still holds, and a mark has no handle to re-read from — it is a
   * contig and a base pair, so what is written is what comes back. See
   * {@link adoptCarriedMarks} for why they have to travel at all.
   */
  private carriedMarks: readonly ManualMark[] | null = null

  /**
   * Remember the loaded tracks, if the file about to open is a different one.
   *
   * Only the rows that are actually readable: a detached row is a name and a
   * colour with no bytes behind it, and carrying it across would produce a
   * second "drop this again" in a session that already has one under the old
   * file's memory.
   *
   * And, for a **change of resolution only**, what was computed as well. That
   * condition is the whole of the difference between the two lists, and it is
   * `AnnotationLoader.carry`'s docstring stated the other way round: a computed
   * row is an answer *about a file*, so carrying one to a different file would
   * hand a reader a picture of somewhere they never pointed at — while the same
   * `.mcool` at another level is the same data, and dropping the analysis there
   * loses numbers this tab is still holding.
   */
  private carry(next: string): void {
    const rows = this.annotations?.store.entries.filter((entry) => entry.status === 'ready')
    this.carried = rows === undefined || rows.length === 0 ? null : [...rows]
    const lanes = this.annotations?.store.placements
    this.carriedLanes = lanes === undefined || lanes.length === 0 ? null : [...lanes]
    const computed = this.reopeningSameFile(next) ? (this.analysis?.carry() ?? []) : []
    this.carriedAnalysis = computed.length === 0 ? null : computed
    const marks = this.annotations?.manual.marks
    this.carriedMarks = marks === undefined || marks.length === 0 ? null : [...marks]
  }

  /**
   * Whether the file about to open is the one already open.
   *
   * The path before `::`, so an `.mcool` at 1 kb and the same `.mcool` at 5 kb
   * are one file — which is exactly the case this asks about. A re-drop of the
   * file already open answers `true` too, and should: nothing has changed there
   * either.
   */
  private reopeningSameFile(next: string): boolean {
    const current = this.file?.uri
    return current !== undefined && splitUri(current).path === splitUri(next).path
  }

  private adoptCarried(loader: AnnotationLoader): void {
    // The marks first, and unconditionally: they travel by a road of their own
    // and a session with no readable tracks still has them to hand over.
    this.adoptCarriedMarks()
    const rows = this.carried
    this.carried = null
    if (rows === null) return
    for (const row of rows) loader.carry(row)
    this.adoptCarriedLanes()
  }

  /**
   * Put the hand-drawn marks into the store the incoming file just built.
   *
   * The tracks' problem, one layer down. Memory is keyed on the *file*
   * ({@link memoryKey}), which is right — two files are two workspaces — and it
   * means a mark placed against one URI is invisible to a store opened on
   * another. Between a map and its own 1D browser that costs nothing, because
   * `hideMap` keeps the file and therefore the key; but a browser opened on a
   * bigWig scopes to the bigWig, and the cooler dropped on it afterwards scopes
   * to the cooler. Same genome, same coordinates, same reader, different key —
   * so four domains boxed while reading the tracks vanished the moment the map
   * they were drawn for arrived. Which is precisely the gesture this feature is
   * for.
   *
   * Carried live, exactly as the tracks are and across the same gap: the two
   * stores never exist at the same moment, so there is nowhere else to hold
   * them. A mark needs nothing re-read — it is a contig and a base pair, with no
   * bytes behind it — so, unlike a track, it comes back whole.
   *
   * **By id, and only what is missing.** A reopen at another resolution hangs
   * its workspace on the same key, so the new store has already read these marks
   * out of storage; adding them again would double every mark on every change of
   * bin size. Ids are minted once per tab and stored with the mark, so "already
   * there" is a question with an answer.
   */
  private adoptCarriedMarks(): void {
    const marks = this.carriedMarks
    this.carriedMarks = null
    const store = this.annotations?.manual
    if (marks === null || store === undefined) return
    const known = new Set(store.marks.map((mark) => mark.id))
    for (const mark of marks) {
      if (!known.has(mark.id)) store.add(mark)
    }
  }

  /**
   * Put the carried rows back on the maps they were on.
   *
   * `begin` places everything it is handed on the lead, which is what importing
   * means and is the wrong answer for a row that is *returning*: a change of
   * resolution is a fresh open, every track is begun again around it, and a deck
   * of four maps each with its own bigWig came back with all four stacked on the
   * first one. The same reopen also loses a companion's own lanes entirely,
   * because nothing else in the session remembers them.
   *
   * Reconciled rather than added to, and only for tracks that came back: a lane
   * list restored on top of `begin`'s lead placement would leave every track on
   * the lead *as well as* where it belongs, which on a deck of four is the same
   * picture four times. Rows the carry dropped — a `computed` one, a `detached`
   * one — keep whatever the new store gave them; their lanes are the analysis
   * workspace's to restore, and it does it from the same snapshot.
   */
  private adoptCarriedLanes(): void {
    const lanes = this.carriedLanes
    if (lanes === null) return
    this.annotations?.store.restoreLanes(lanes)
  }

  /**
   * The key this session's per-file memory hangs on.
   *
   * The session id is in it, and has to be: two tabs on the same file are two
   * independent workspaces, and keying their tracks and filters on the URI alone
   * would make the second one adopt the first one's — which is exactly the
   * behaviour tabs exist to prevent.
   *
   * **The file, not the entry inside it.** The path before `::`, so an `.mcool` at
   * 1 kb and the same `.mcool` at 5 kb hang their workspace on one key — which is
   * the definition of "the same file" {@link reopeningSameFile} already uses, and
   * the reason {@link carryAcrossEntries} carries every field of a view state
   * across a change of resolution: names are names and coordinates are base pairs.
   * Everything under this key is the same kind of fact. A hand-drawn mark is a
   * contig and a base pair (§8.1), a ticked sequence is a name, a group is a claim
   * about tracks, a table's filter is a phrase about rows — none of them means
   * anything different at another bin size.
   *
   * With the entry in the key they were all *lost* on a resolution switch, and
   * silently: the previous level's marks were still in storage under its own key,
   * so they came back if you switched back and stayed invisible if you did not.
   * The tracks survived only because they are carried live across the reopen
   * ({@link carry}), which is why this was a bug about marks rather than about
   * everything at once.
   *
   * The rule itself is `state/UiMemory.ts`'s, beside the storage it keys.
   */
  private memoryKey(uri: string): string {
    return fileMemoryKey(this.id, uri)
  }

  /**
   * The key this session's *own* memory hangs on, whatever is on screen.
   *
   * {@link memoryKey} for the file this session is of, and `null` before there
   * is one. What it is for is the handful of facts that are about the session
   * rather than about one of the files in it — the names of every map it is
   * holding, above all, which have to sit under one key or a saved workspace
   * would carry the lead's and none of the others' (`ui/mapNames.ts`).
   */
  private sessionKey(): string | null {
    const uri = this.store.state?.uri ?? this.file?.uri ?? this.assembly?.uri
    return uri === undefined ? null : this.memoryKey(uri)
  }

  /**
   * The circular declarations for the file on screen, built on demand.
   *
   * Rebuilt when the key changes rather than on every call, because the store
   * reads storage in its constructor and the control asks for it once per
   * render. Keyed on {@link sessionKey} for the reason that key exists: a
   * declaration is about the *file*, and an `.mcool` at 1 kb and the same file
   * at 5 kb are one file.
   */
  private circularHeld: { key: string; store: CircularStore } | null = null

  private circularStore(): CircularStore | null {
    const key = this.sessionKey()
    if (key === null) return null
    if (this.circularHeld?.key !== key) this.circularHeld = { key, store: new CircularStore(key) }
    return this.circularHeld.store
  }

  /**
   * The *this sequence is circular* control, for a view that is a window on one.
   *
   * `undefined` on every other view, and each exclusion is a question the
   * tickbox could not answer honestly: a two-contig block has no diagonal to
   * slide along, a whole-genome picture is a list of sequences of which some may
   * be circular and some not, and a name that is not a sequence of this file is
   * a genome or a typo (SPECS §8.15).
   */
  private circularPresentation(state: ViewState): CircularPresentation | undefined {
    if (state.view !== 'region' || state.region === undefined || state.region2 !== undefined) {
      return undefined
    }
    const store = this.circularStore()
    if (store === null) return undefined
    const names = this.contigNames()
    if (names === null) return undefined
    // Through `contigOf`, which is what resolves `chrI:20,000-80,000` to `chrI`
    // and a Roman numeral the reader typed to the spelling the file uses (§5.9).
    // `null` is a region naming a genome or nothing this file has, and neither is
    // a sequence a declaration could be about.
    const name = contigOf(state.region, names)
    if (name === null) return undefined
    return {
      label: name,
      on: store.has(name),
      onChange: (on) => {
        store.set(name, on)
        // **Not a remount.** The declaration changes how the block is *read* —
        // wrapped or not, with a ceiling or a lap — so the ladder has to be
        // built again; but a remount would rebuild the view from its named
        // region and throw away the reader's zoom, which is the one thing they
        // had to do to get somewhere worth asking the question from. The view
        // re-arms its ladder against the block already on screen instead.
        this.current?.setCircular?.(on)
      },
    }
  }

  /**
   * A framing with the reader's circular declarations attached.
   *
   * Added here rather than in the panel, and that is the point: the declaration
   * is about the **file** and the panel knows about the one sequence it is
   * showing. A task run from a whole-genome view on a file with three circular
   * plasmids has to measure all three of them the short way round, and a framing
   * that carried only what happened to be on screen would give one answer from
   * one view and another from another.
   */
  /** Every map name this session is holding; `{}` before there is a file. */
  private mapNames(): MapNames {
    const key = this.sessionKey()
    return key === null ? {} : readMapNames(key)
  }

  /**
   * What to call one of this session's maps — the reader's name, else the file's.
   *
   * Every label on screen goes through here: the Contact maps card, a deck
   * panel's heading, the readout under the pointer, the two bands of a turned
   * comparison, and the caption on an exported figure. One function, so a map
   * renamed in the card is renamed in the figure without anything having to be
   * told.
   */
  mapLabel(uri: string): string {
    return mapLabelIn(this.mapNames(), uri)
  }

  /**
   * Call one of this session's maps something, or hand it back to its file name.
   *
   * `null` — or a box the reader emptied — is what makes a rename undoable, on
   * the tab strip's rule. Everything on screen is rebuilt afterwards rather than
   * patched: the name is on the card, in the heading, in the readout, in the
   * key and in the caption, and a rename that moved four of those and not the
   * fifth is the one way this can be quietly wrong.
   */
  private renameMap(uri: string, name: string | null): void {
    const key = this.sessionKey()
    if (key === null) return
    const held = this.mapNames()
    const next = withMapName(held, uri, name)
    if (mapNameIn(next, uri) === mapNameIn(held, uri)) return
    remember(key, MAP_NAMES_SCOPE, next)
    this.compareCard?.sync()
    this.deck?.renamed()
    // Written into the mounted panel rather than through {@link remount}: a
    // rename changes what the picture is *called* and nothing about what is in
    // it, and rebuilding the view would put a gated whole-genome scan (§7.3)
    // back behind its button — the reader types a name and their map goes away.
    const own = this.file === null ? undefined : this.mapLabel(this.file.uri)
    if (own !== undefined) {
      this.current?.panel?.setMapLabels(
        own,
        this.compare === null ? undefined : this.mapLabel(this.compare.uri),
      )
    }
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
      // …and remembered *here* instead, in this session's own memory, where a
      // file name is as private as the file. The hash stays exactly as honest
      // as it was; what changes is that this browser can put the comparison
      // back on a reload, the way it now puts the first file back.
      else remember(this.memoryKey(this.store.state?.uri ?? uri), 'compare:local', uri)
      this.remount()
    } catch (err) {
      client.terminate()
      if (this.destroyed) return
      // A collection addressed at its root is a `KeyError` in Python and the
      // reader mirrors it faithfully (§3.4) — but somebody who dropped an
      // `.mcool` on the compare card meant "this map", so the entry is opened
      // for them, exactly as it is when the same file is dropped on the picker.
      // The resolution *this map is at*, where the collection has it: two files
      // with the same five levels are comparable at any of them, and landing on
      // the finest regardless meant a reader looking at 1 kb was told the bin
      // sizes differ by a file that has 1 kb in it. Where it does not, the
      // finest is the fallback and the gate's bin-size clause says so by name.
      const landing = firstEntry(err, file.info.binsize ?? undefined)
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
    return this.compare === null
      ? ''
      : `${this.compare.uri}|${String(this.normalising())}|${this.compareOp()}`
  }

  /**
   * How the two open files are put together, from the view state.
   *
   * `split` wherever there is no second file, so that a link carrying `op=ratio`
   * and one file lands on that file's own map rather than on a comparison with
   * nothing — the same thing a `uri2` naming a local file does (§11).
   */
  private compareOp(): CompareOp {
    if (this.compare === null) return 'split'
    return this.store.state?.op ?? 'split'
  }

  /**
   * Put a remembered local comparison back, or forget it.
   *
   * Silent on failure, and that is the right shape: the reader did not ask for
   * this file *now* — they asked for it last week and closed their browser — so
   * a grant that has lapsed is not an error to report, it is a comparison that
   * simply is not there. The note is dropped with it so the next render does not
   * try again, and the Compare card is where they were always going to re-open
   * it from.
   */
  private async reopenCompare(uri: string): Promise<void> {
    const source = await resolveSource(uri)
    if (this.destroyed) return
    const held = this.store.state?.uri
    if (source === null) {
      if (held !== undefined) remember(this.memoryKey(held), 'compare:local', undefined)
      return
    }
    // Re-checked after the await: the reader may have opened one by hand, or
    // navigated to another file entirely, while the grant was being asked for.
    if (this.compare !== null || this.compareOpening !== null) return
    await this.openCompare(uri, source)
  }

  private dropCompare(): void {
    const local = this.compare !== null && this.compare.source.kind === 'local'
    this.compare?.client.terminate()
    this.compare = null
    this.compareHidden = false
    this.compareCard?.set({ kind: 'empty' })
    this.infoPanel?.setCompare(null)
    // Closing a local comparison has to forget it as well as put it down, or the
    // next reload would open again the one thing the reader just closed — the
    // `uri2` half of the same act is a patch on the hash, and this is its
    // counterpart for the half the hash never held.
    //
    // Not while one is being *carried* across a change of resolution: the note
    // is how a local second file finds its way back, and forgetting it there
    // would put down the very comparison the carry exists to keep. The re-open
    // writes it again under the same key — the key is the file rather than the
    // rung (`state/UiMemory.ts`) — so nothing has to be moved.
    const uri = this.store.state?.uri
    if (local && uri !== undefined && this.compareCarry === null) {
      remember(this.memoryKey(uri), 'compare:local', undefined)
    }
  }

  /**
   * Hold on to the second file, if the open about to happen is a change of
   * resolution rather than a change of subject.
   *
   * The test is {@link reopeningSameFile}'s, which is the path before `::` and
   * therefore already says "the same `.mcool` at another bin size". Every other
   * open — a different file, a genome, the picker — leaves this `null` and the
   * comparison is dropped with the file it belonged to, which is what it has
   * always meant.
   */
  private carryCompare(next: string): void {
    const held = this.compare
    this.compareCarry =
      held === null || !this.reopeningSameFile(next)
        ? null
        : {
            uri: held.uri,
            source: held.source,
            entries: held.info.entries,
            entryGroup: held.info.entryGroup,
            binsize: held.info.binsize,
            hidden: this.compareHidden,
          }
  }

  /**
   * Put the carried second file back, at the rung the first one has moved to.
   *
   * **The bin size carries, not the URI.** The second file has a ladder of its
   * own, so `rep2.mcool::/resolutions/1000` beside a 1 kb map is
   * `…/resolutions/5000` beside a 5 kb one — and the rung is looked up in the
   * second file's own entries rather than assumed to be spelled the same way.
   * A plain `.cool` has no entries and needs none: it is already at one bin size,
   * and if that is the new one it comes straight back.
   *
   * A file with no rung at the new resolution **cannot be compared there**, and
   * that is the gate's rule rather than a shortcoming here: two bin sizes in one
   * square would draw a pixel that means 1 kb on one side of the diagonal and
   * 5 kb on the other. So it is put down with the reason on the card, where the
   * reader is already looking for the name of the file that has gone — rather
   * than carried into a refusal they would have to read as a bug.
   */
  private restoreCarriedCompare(carried: CompareCarry, uri: string, info: OpenResult): void {
    // Spent here, and here only: while it stands, `render` leaves the
    // comparison alone, and the whole point of the next two lines is that
    // something is about to be in flight for it.
    this.compareCarry = null
    const moved = compareRung(carried, info.binsize)
    if (moved === null) {
      this.compareCard?.set({
        kind: 'error',
        label: fileLabel(carried.uri),
        message:
          `${fileLabel(carried.uri)} has no ${fmt.bp(info.binsize ?? 0)} level, so it cannot be ` +
          `compared at this resolution — two bin sizes in one square would draw a pixel that ` +
          `means one thing above the diagonal and another below it.`,
      })
      remember(this.memoryKey(uri), 'compare:local', undefined)
      return
    }
    // Restored before the open rather than after it: the eye is a fact about
    // the *reading* and the reader did not touch it, so a hidden triangle has
    // to stay hidden while the file behind it is read again. Set now because
    // `openCompare` is asynchronous and `compareContext` is consulted in
    // between — and it is only ever read with a second file open, which is
    // exactly when this is true again.
    this.compareHidden = carried.hidden
    void this.openCompare(moved, carried.source)
  }

  /**
   * Whether the second file's counts are scaled to the first's bright end.
   *
   * A preference rather than view state: it changes how the picture is drawn and
   * not what is in it, and it is per session because it is a fact about *these
   * two files* — one being shallower than the other — rather than about the
   * viewer.
   *
   * `undefined` where nothing has been remembered, and the panel takes it from
   * there: the sensible default differs between the split and the derived
   * operations and between balanced values and raw counts, and only the panel
   * knows which of those it is drawing. Collapsing the absent case to `false`
   * here would hand it a choice the reader never made.
   */
  private normalising(): boolean | undefined {
    return recall<boolean>(this.memoryKey(this.file?.uri ?? ''), 'compare:normalise') ?? undefined
  }

  /** What a heatmap view needs to read and label the second file, or `undefined`. */
  private compareContext(): CompareRead | undefined {
    const held = this.compare
    const file = this.file
    if (held === null || file === null || this.compareHidden) return undefined
    return {
      client: held.client,
      labels: [this.mapLabel(file.uri), this.mapLabel(held.uri)],
      normalise: this.normalising(),
      onNormaliseChange: (on) => {
        remember(this.memoryKey(file.uri), 'compare:normalise', on)
        this.remount()
      },
      // In the view state rather than in session memory, unlike the depth match
      // beside it: that one changes how the picture is drawn, this one changes
      // what is in it. A link naming a ratio has to produce a ratio.
      op: this.compareOp(),
      onOpChange: (op) => {
        this.store.patch(op === 'split' ? { op: undefined } : { op })
        // A remount, unlike the baseline beside it: the split needs the second
        // file's own block kept per-file and the derived operations do not, so
        // the *controls* differ between them — the depth tickbox is there under
        // one and not under the others — and the controls are built once, at
        // construction.
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

  // -------------------------------------------------------------------------
  // The deck of panels (§16)
  // -------------------------------------------------------------------------

  /**
   * What was last handed to {@link showContent}, so a deck built *after* a view
   * was mounted can frame it without re-reading its block.
   */
  private contentNode: HTMLElement | null = null

  /**
   * Bring the companions in line with the hash, and put the deck down when the
   * last of them is closed.
   *
   * Built lazily and destroyed eagerly, so a session with one map holds no
   * deck, no lock and no toolbar — it is byte for byte the session it was
   * before panels existed, which is the property that makes this feature
   * additive rather than a rewrite of the router.
   */
  /**
   * The local companions this session wrote down, still in range of the hash.
   *
   * The hash keeps a `~` for each of them (§16.6) and this says which file each
   * `~` was, so the two have to agree about *how many* cells there are: a
   * remembered index past the end of the current `maps` is from a deck that has
   * since shrunk, and promoting it would grow the deck back by a cell the reader
   * closed. Filtered here rather than in `withLocalCompanions`, which is a pure
   * function over one list and cannot know which is the newer.
   */
  private rememberedCompanions(state: ViewState): Array<{ index: number; uri: string }> {
    const width = parseMaps(state.maps).length
    if (width === 0) return []
    const stored = recall<DeckLocal[]>(this.memoryKey(state.uri), 'deck:locals')
    if (!Array.isArray(stored)) return []
    return stored.filter(
      (local) =>
        typeof local?.uri === 'string' &&
        local.uri !== '' &&
        Number.isInteger(local?.index) &&
        local.index >= 0 &&
        local.index < width,
    )
  }

  private async syncDeck(state: ViewState): Promise<void> {
    // A hash naming companions is not a reason to build a deck the file cannot
    // have (§16, {@link deckIsPossible}). A link outlives the file it was made
    // from, and one made against a cooler and opened on a metagenome would
    // otherwise put five panels round a map none of them can follow.
    if (this.file?.info.hasGenomes === true) return
    const remembered = this.rememberedCompanions(state)
    if (this.deck === null && parseMaps(state.maps).length === 0 && remembered.length === 0) return
    // Asked *before* the deck is handed the state, because resolving a grant is
    // asynchronous and nothing inside `PanelDeck` may be. All of them at once:
    // four companions are four independent files and there is nothing to gain
    // from asking one after another.
    const locals = await Promise.all(
      remembered.map(async (local) => ({
        ...local,
        source: await resolveSource(local.uri),
      })),
    )
    if (this.destroyed) return
    const deck = this.ensureDeck()
    deck.apply(state, locals)
    if (!deck.isEmpty) return
    deck.destroy()
    this.deck = null
    // The frame has gone with it, so the mounted view has to be put back on its
    // own — back inside the `+` edges, which is where it was before anybody
    // pressed one. Directly rather than through a re-render: the view is intact
    // and re-reading its block to change what it is parented into would make
    // closing the last companion cost a fetch.
    if (this.contentNode !== null) this.contentEl.replaceChildren(this.framed(this.contentNode))
  }

  /**
   * What actually goes in the content area: the view, and one frame round it.
   *
   * Exactly one, and which one is the whole of the logic here. A view a
   * companion cannot answer gets neither — a table or an overview is of *this
   * file* and nothing else, so framing one put a genomes table into a sixth of
   * the column beside five rectangles each saying they had nothing to draw
   * (§16.8), and offering a `+` there would offer to open a cell for a picture
   * nothing can fill. A view with a **deck** gets the deck, which grows its own
   * edges round its grid. A view with neither gets the bare edges, so the
   * gesture that builds the first deck is on screen from the first map.
   */
  private framed(node: HTMLElement): HTMLElement {
    // Released on both of the paths that leave a frame off screen, because
    // every one of them holds the last view it framed until told otherwise — a
    // *destroyed* view, whose canvas is still a full-resolution backing store.
    // Re-parenting into a frame empties the other for free (a node has one
    // parent); a bare mount does not, so a reader who opens the chromosomes
    // table pins the map they left.
    //
    // Both frames, and that used to be one: the deck was left out, so the whole
    // argument above applied to it and nothing acted on it. A deck holds its
    // lead in `leadCell` and the lead's own heading up in its bar, so the
    // retention was two nodes rather than one — see `PanelDeck.release`, which
    // is why this is a call rather than an inlined `replaceChildren` here.
    const deck = this.deck
    if (!this.deckIsPossible) {
      this.deckEdges.release()
      deck?.release()
      return node
    }
    if (deck !== null) {
      this.deckEdges.release()
      return deck.frame(node)
    }
    return this.deckEdges.hold(node)
  }

  /**
   * The deck, built if this session has none yet.
   *
   * The build re-frames immediately rather than waiting for the next render,
   * because the two ways a deck comes into existence are a hash that already
   * names companions — where a render is about to happen anyway — and the "add
   * a map" command, where one is not and where a grid that appeared on the next
   * navigation would read as a bug.
   */
  private ensureDeck(): PanelDeck {
    if (this.deck !== null) return this.deck
    const deck = new PanelDeck({
      // `replace`, always. Building a deck one file at a time should leave one
      // history entry rather than five that each undo a file — the same rule
      // the colour controls follow, and for the same reason: adding a map to
      // what is on screen is not a navigation away from it.
      onMapsChange: (maps) => this.store.patch({ maps }, { replace: true }),
      memoryKey: () => this.memoryKey(this.file?.uri ?? ''),
      leadName: () => (this.file === null ? undefined : this.mapLabel(this.file.uri)),
      // Without the handler: §7.5's controls belong to the lead, and every
      // companion draws what they say without offering a second copy of them.
      derive: () => {
        const state = this.store.state
        if (state === null) return undefined
        const { onExpectedChange: _own, ...shared } = this.derivePresentation(state)
        return shared
      },
      annotations: (map) => this.annotationContext(map),
      /**
       * The star moved, or the map it was on finished reading its tables.
       *
       * Every answer the Analysis column gives is about one file — what a task
       * costs, which sequences its form lists, whether a task applies at all —
       * so a star that has moved invalidates all of them at once. `refresh` is
       * the same call a navigation makes, for the same reason.
       */
      onStarChange: () => {
        this.analysis?.refresh()
      },
      // Through the memoised index rather than `contextOf` directly: this is
      // asked once per block read per panel, and recomputing it over a 154 k
      // contig table is 71 ms of a frame that has a matrix to draw.
      leadNaming: () => {
        const names = this.contigNames()
        return names === null ? undefined : NameIndex.for(names).context
      },
      leadLabel: () => this.mapLabel(this.file?.uri ?? ''),
      mapLabel: (uri) => this.mapLabel(uri),
      onRenameMap: (uri, name) => this.renameMap(uri, name),
      onRenameLead: (name) => {
        const uri = this.file?.uri
        if (uri !== undefined) this.renameMap(uri, name)
      },
      // Stripped the same way and for the same two reasons. `onChange` would be
      // a sixth copy of a control over something the deck shares; `onAvailable`
      // would let a companion whose block has no diagonal un-turn the whole
      // deck, which is a fact about that one file deciding what every other one
      // is drawn as.
      turn: () => {
        const state = this.store.state
        if (state === null) return undefined
        const { onChange: _own, onAvailable: _grey, ...shared } = this.turnPresentation(state)
        return shared
      },
      binsize: () => this.file?.info.binsize ?? undefined,
      // The two directions "fix all …" needs that the deck cannot take itself.
      //
      // A clip written straight onto the lead's panel is one the next render
      // puts back — the lead's view is rebuilt from the *state*, which is where
      // its colour lives — so it goes through the store, exactly as the
      // Aesthetics column's own controls do, and travels in the link with them.
      onLeadScale: (scale) => this.store.patch(scale, { replace: true }),
      // And its resolution is the breadcrumb's entry picker from the other end:
      // changing the first map's rung means reopening the file the session *is*.
      // Answers whether it *could*, so the deck can name it in the one line it
      // has for a map with no frame of its own.
      onLeadBinsize: (binsize) => this.openAtBinsize(binsize),
      score: () => {
        const state = this.store.state
        return state === null ? undefined : this.scoreOf(state).id
      },
      // A companion's clip is not a navigation, so nothing on the state road
      // fires for one — and the durable record and the exported workspace are
      // both rebuilt from this session's memory on `sessionChanged`. The same
      // line the annotation store subscribes with, for the same reason.
      onLooksChange: () => this.host.sessionChanged(this),
    })
    this.deck = deck
    // `isConnected`, because the node this holds may be one a render in
    // progress is about to replace — and framing a detached view would put the
    // outgoing picture on screen inside a grid, one frame before the incoming
    // one arrives through `showContent` and does it properly.
    if (this.contentNode !== null && this.contentNode.isConnected && this.deckIsPossible) {
      this.contentEl.replaceChildren(this.framed(this.contentNode))
      deck.setLead(this.current?.panel ?? null)
    }
    return deck
  }

  /** The "add a map" command: open a deck if there is none, and ask for a file. */
  private addMap(): void {
    // The command is already disabled where this is false; the guard is for the
    // other door into it — a keyboard shortcut fired before a render has
    // re-read the state (§16, {@link deckIsPossible}).
    if (this.file === null || !this.deckIsPossible) return
    this.ensureDeck().promptAdd()
  }

  /**
   * The `+` on an edge of the map: draw the deck, or make the one there bigger.
   *
   * The entry point §16.9 exists to provide, and it deliberately opens **cells**
   * rather than maps: what comes back from one press is the arrangement the
   * reader asked for with their own map in the first cell of it, every other
   * cell standing empty and taking a drop. A file arriving with the press — one
   * dropped on the edge rather than a click — goes straight into the first of
   * them, so the impatient gesture and the deliberate one reach the same deck.
   */
  private growDeck(direction: GrowDirection, picked?: PickedFile): void {
    if (this.file === null || !this.deckIsPossible) return
    this.ensureDeck().grow(direction, picked)
  }

  /**
   * Whether a second panel would have anything to draw.
   *
   * The deck answers views that name a *place* — a region, a genome, a pair, a
   * selection, the whole file — and there are three that name a **file**
   * instead: the two tables and the whole-metagenome scan. A second file's
   * genomes table is not this file's genomes table with more in it, it is
   * another table, so offering a panel there would be offering to put two
   * unrelated pages side by side. The command is disabled rather than hidden,
   * so the answer to "can this viewer do that" is *yes, from a map*.
   *
   * **And never on a file with a genome layer.** §16 is built on the one thing
   * a deck's panels must share — a coordinate system — and two metagenomes have
   * none: their axes are contigs from two independent assemblies, so a region
   * that names a place in one names nothing in the other, and the lock that
   * moves five maps together would be moving them to five different places. It
   * is the same argument §8.5 makes about a track and `compareRefusal` makes
   * about the lower-left triangle, and it is stronger here because a deck
   * *navigates*: the reader would not be shown a wrong picture once, they would
   * drag one about. So the `+` edges are absent rather than disabled, which is
   * what this predicate decides — see {@link framed}.
   */
  private get deckIsPossible(): boolean {
    if (this.file?.info.hasGenomes === true) return false
    const view = this.store.state?.view
    return view === 'region' || view === 'genome' || view === 'pair' || view === 'whole' || view === 'selection'
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
  /**
   * The turn, as every panel of the session sees it.
   *
   * Deck-wide by construction: it is built from the state, and every panel is
   * handed the same state, so a flip is one key and N pictures. Which way each
   * one grows is the caller's — a lone map and the first file of a comparison
   * grow up, the second grows down so the pair meets at one axis.
   */
  private turnPresentation(state: ViewState, direction?: RotateDirection): TurnPresentation {
    return {
      // Absent is *on*: a block with a diagonal opens as a band along a genomic
      // axis, and the square is what a reader asks for rather than what they are
      // given. Only an explicit `false` turns it back, which is what keeps the
      // hash of an ordinary view short and a link with no `flip` in it opening
      // the way this viewer opens.
      on: state.flip !== false,
      ...(direction === undefined ? {} : { direction }),
      onChange: (on) => {
        this.store.patch({ flip: on ? undefined : false })
        this.rederive()
      },
      // Nothing to write back where the block has no diagonal. The control goes
      // flat and the picture is square, both decided by `isTurnable` at the
      // moment of drawing; recording the refusal in the state would make a
      // metagenome the reader passed through switch the turn off for every map
      // after it, which is a preference edited by a navigation.
    }
  }

  /**
   * Recompute the picture without re-reading it.
   *
   * A derivation is a transform over cells that are already on screen, so it
   * must not go through {@link remount}: that destroys the view, and on a gated
   * whole-genome map (§7.3) the rebuilt one puts a full pixel scan back behind
   * its button — the reader ticks a box and their map disappears.
   *
   * The presentation is rebuilt from the state rather than passed in, so this
   * has one source of truth with every other render.
   */
  private rederive(): void {
    const state = this.store.state
    if (state === null) return
    this.current?.panel?.rederive(this.derivePresentation(state), undefined, this.turnPresentation(state))
  }

  private remount(): void {
    const state = this.store.state
    if (state === null) return
    this.mounted = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    void this.render(state)
  }

  /** The context a heatmap view hands to its panel, or `undefined`. */
  private annotationContext(map?: string): AnnotationContext | undefined {
    const held = this.annotations
    return held === null
      ? undefined
      : {
          store: held.store,
          ...(map === undefined ? {} : { map }),
          manual: held.manual,
          client: held.client,
          groups: held.groups,
          contigLength: held.contigLength,
          // The file's own columns (§8.12). Handed to every panel, including a
          // deck's companions: a lane is placed per map like any other, so a
          // MAG's contamination can be drawn beside the replicate it belongs to
          // as easily as beside the lead.
          ...(held.metadata === undefined ? {} : { metadata: held.metadata }),
          // Dropped on the map itself, on the edge the reader aimed at. A
          // `.cool` still opens as a map and a `chrom.sizes` still replaces the
          // lengths — `dropped` decides that by name, exactly as it does for a
          // file dropped anywhere else — so the edge is carried through it
          // rather than around it, and only reaches the loader for the files
          // that actually become tracks.
          // Dropped on a *companion's* edge, the track belongs to that map and
          // not to the session's own: the lane is moved the moment the import
          // exists, because `begin` places every new track on the lead — which
          // is what importing has always meant and is right for every drop but
          // this one.
          loadOnEdge: (files, edge) => {
            this.droppedAll(files, placementOn(edge), map)
          },
          // The same aim, at a row out of the Files panel. Resolved here rather
          // than in the panel that took the drop, because reading the file is a
          // fetch or a permission check and a drop handler cannot await: the
          // event's payload is read synchronously and the file arrives later, by
          // which time the `DataTransfer` is dead and the map may have changed
          // under it — which is why `destroyed` is re-checked.
          pickOnEdge: (event, edge) => {
            void readFileDrag(event).then((picked) => {
              if (picked === null || this.destroyed) return
              void this.addPicked(picked, placementOn(edge), map)
            })
          },
        }
  }

  /**
   * Reopen this session's own file at `binsize`, and say whether it could.
   *
   * The deck's *fix all resolutions* reaching the one map it cannot move by
   * itself: a companion changes rung inside its own worker, and the first map is
   * the file the *session* is of, so moving it is the breadcrumb's entry picker
   * from the other end — the same `open` with the same carried view state, so
   * the region, the level and the score all survive the hop (§3.4).
   *
   * **Exact**, on {@link MapPanel.useBinsize}'s rule and for its reason: the
   * button has just promised one resolution across the deck, and answering with
   * the nearest thing would leave two while saying one. `false` is a file that
   * has not got that level, which the deck names in its own line — this map has
   * no frame of its own to be told in.
   */
  private openAtBinsize(binsize: number): boolean {
    const held = this.file
    if (held === null || !Number.isFinite(binsize) || binsize <= 0) return false
    if (held.info.binsize === binsize) return true
    const match = rungsOf(held.entries).find((rung) => rung.binsize === binsize)
    if (match === undefined) return false
    if (match.name === held.currentEntry) return true
    const group = held.info.entryGroup || 'entries'
    const next = `${splitUri(held.uri).path}::${group}/${match.name}`
    void this.open(next, held.source, this.carryAcrossEntries(next))
    return true
  }

  /**
   * *Bookmark this view*, on the title line beside `go`.
   *
   * Built here rather than in the view for the reason {@link mapToggleButton} is:
   * what it saves is the window the panel is showing and where it saves it is a
   * store the session owns, and neither is something a view mounted for one region
   * knows about.
   *
   * `undefined` on a file with no bookmarks card, which is §8.5's gate — a
   * metagenome has no annotation stores at all, and a button that saved into
   * nothing would be furniture.
   *
   * It reports by *going quiet*: the press is confirmed by the row appearing in
   * the card, which is where the reader will look for it, and pressing it a second
   * time on the same view says so in the card's own line rather than as a toast
   * over the map (`BookmarkStore.add`).
   */
  private bookmarkButton(): HTMLElement | undefined {
    if (this.bookmarksCard === null) return undefined
    return iconButton(
      'bookmark-plus',
      'Bookmark this view — the place on screen, at this resolution',
      () => this.bookmarksCard?.saveFramed(),
    )
  }

  /**
   * Take the reader to a saved place (§8.10).
   *
   * **The whole chromosome, zoomed to the place** — `region` is the contig and the
   * location goes in `focus`. That is the one design decision in here and it is
   * the reader's own requirement: a bookmark whose region was `chrI:1.20-1.26 Mb`
   * would open a block cut at those coordinates, and panning out of it would show
   * paper rather than the rest of the chromosome. `ViewState.focus` is a window
   * over a block read whole, so arriving somewhere and looking around works.
   *
   * **And at the resolution it was saved at**, when the file has one: a bookmark
   * is a place *and* a grain, because a loop found at 1 kb is not visible at 20 kb
   * and giving back the coordinates without the grain gives back a picture the
   * note was not made against. A bin size this file has no rung for is dropped
   * rather than approximated — the nearest thing would be a different picture
   * presented as the saved one — and a bookmark imported from BED never had one.
   *
   * What carries: **how the file is being read** — the transform, the colormap,
   * the level, balancing, the score column — plus whatever {@link navigate}
   * already carries, which is the deck, the compared file and the turn. Those are
   * facts about the reader rather than about the place, and finding the map square
   * and grey again after every jump would make a list of twenty bookmarks
   * unusable. The **clip** does not carry, on `carryAcrossEntries`'s rule and for
   * its reason: `vmax` is in counts, counts scale with the bin, and a ceiling
   * tuned on one window is a black square or an empty one on the next.
   */
  private goToBookmark(mark: Bookmark): void {
    const state = this.store.state
    if (state === null) return
    this.navigate({
      uri: this.uriAtBinsize(mark.binsize) ?? state.uri,
      view: 'region',
      region: mark.contig,
      focus: formatRegion(mark),
      ...(state.transform === undefined ? {} : { transform: state.transform }),
      ...(state.colormap === undefined ? {} : { colormap: state.colormap }),
      ...(state.level === undefined ? {} : { level: state.level }),
      ...(state.balance === undefined ? {} : { balance: state.balance }),
      ...(state.score === undefined ? {} : { score: state.score }),
    })
  }

  /**
   * This file addressed at `binsize`, or `null` for "leave it where it is".
   *
   * {@link openAtBinsize}'s address arithmetic without its navigation, for a
   * caller that is building one state rather than moving to one. Exact on the same
   * rule: a bin size the collection has no rung for is refused, because the
   * nearest rung is a different picture and a bookmark has promised this one.
   */
  private uriAtBinsize(binsize: number | undefined): string | null {
    const held = this.file
    if (held === null || binsize === undefined) return null
    if (held.info.binsize === binsize) return null
    const match = rungsOf(held.entries).find((rung) => rung.binsize === binsize)
    if (match === undefined || match.name === held.currentEntry) return null
    return `${splitUri(held.uri).path}::${held.info.entryGroup || 'entries'}/${match.name}`
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

  /**
   * Record a score choice, in the two fields that between them say what a link
   * means.
   *
   * `balance` is written exactly as it always was — a link from before this
   * control existed still says `balance=1`, and one written today still has to
   * be readable by a build from before it — and `score` carries the rest. The
   * plain and balanced choices therefore leave `score` off entirely, so the
   * common cases produce the same hash they did yesterday.
   */
  private setScore(choice: ScoreChoice): void {
    this.setBalance(choice.balance)
    // Every choice but the two legacy ones writes its id. The test cannot be
    // "does it name a column" any more: a computed normalisation names none and
    // still has to be carried, or picking `VC` would leave the hash saying
    // `counts` and a shared link would show the wrong numbers.
    const legacy = choice.id === COUNT_SCORE || choice.id === BALANCED_SCORE
    this.store.patch({ score: legacy ? undefined : choice.id })
  }

  /**
   * The `/pixels` column the reads should take, or `undefined` for `count`.
   *
   * Resolved through the same list the picker is built from, so a hash naming a
   * column this file does not have falls back to counts rather than to a read
   * that cannot be served — the state is a shared link and every field of one is
   * untrusted input.
   */
  private valueOf(state: ViewState): string | undefined {
    return this.scoreOf(state).value
  }

  /**
   * The normalisation to compute from the block, or `undefined` for none.
   *
   * Resolved through the picker's own list for {@link valueOf}'s reason: a hash
   * naming one has to land on something this build can serve, and there is
   * exactly one place that decides what that is.
   */
  private normaliseOf(state: ViewState): Normalisation | undefined {
    return this.scoreOf(state).normalise
  }

  /**
   * The picker entry the state resolves to, whichever field named it.
   *
   * Through {@link balanceOf} and not through `state.balance`, which is what
   * every view that mounts a picker does — a cooler somebody balanced opens
   * balanced and that default is nowhere in the hash. Read straight, this said
   * `count` for a map whose own picker said `balanced`, which cost nothing
   * while the only two callers wanted a column and a normalisation (neither of
   * which the default touches) and cost a whole quantity the moment a deck
   * asked what score to share.
   */
  private scoreOf(state: ViewState): ScoreChoice {
    const props = this.scoreProps(state)
    return scoreFor(scoreChoices(props), { ...props, balance: this.balanceOf(state) })
  }

  /**
   * What every map view needs to draw and drive the baseline toggle.
   *
   * Built here rather than in each view for the reason the score picker's props
   * are: four views mount the same panel, and a default decided four times is a
   * default that comes to differ in three of them.
   */
  private derivePresentation(state: ViewState): DerivePresentation {
    const normalise = this.normaliseOf(state)
    return {
      ...(normalise === undefined ? {} : { normalise }),
      expected: state.oe === true,
      onExpectedChange: (on) => {
        this.store.patch({ oe: on ? true : undefined })
        this.rederive()
      },
      // From the score rather than from a key of its own: the correlation *is*
      // one of the answers to "what are these numbers", and it carries the
      // balancing and the baseline it needs with it (`ui/scores.ts`).
      correlate: this.scoreOf(state).correlate === true,
      // Also from the score, and for the same reason: "show me the denominator"
      // is an answer to what the cells are, not a second switch beside the one
      // that divides by it (`ui/scores.ts`).
      baseline: this.scoreOf(state).baseline === true,
      onCorrelateChange: (on) => {
        // There is no correlation toggle to flip any more, so the only caller is
        // the failure path below, and the only thing "off" can mean is the score
        // it was standing on: balanced counts, which is what it was computed
        // from and the nearest picture to what the reader asked for.
        if (!on) this.store.patch({ score: BALANCED_SCORE })
        this.rederive()
      },
      correlateBlock: (values, n, onProgress) => this.correlate(values, n, onProgress),
      smoothBlock: (request) => this.smooth(request),
      onCorrelateFailure: (message) => {
        // The panel has already asked for the score to move, so this only says
        // what happened. Without the move the next render would ask for the
        // correlation again and the failure would repeat once per frame.
        this.host.notify(`Correlation failed: ${message}`)
      },
      smooth: state.smooth ?? '0',
      onSmoothChange: (token) => {
        // `0` is written as *absent*, like `oe`'s `false`: the two mean the same
        // thing and a hash carrying `smooth=0` would be a link saying it had
        // chosen the default.
        //
        // **Picking the adaptive window turns the O/E on**, exactly as clicking
        // the toggle would: the ramp goes diverging and `log2` because
        // `deriveBlock` gives the result a neutral of 1, and everything follows
        // from that one number. It is not a shortcut but the picture the setting
        // is for — the window is sized on the counts and divided by a baseline
        // averaged over that same window, and on raw counts all it can denoise
        // is a picture of the distance decay everybody already has. Turning it
        // *off* again is left to the reader, who may want exactly that.
        const wantsExpected = parseSmooth(token)?.kind === 'adaptive'
        this.store.patch({
          smooth: token === '0' ? undefined : token,
          ...(wantsExpected ? { oe: true } : {}),
        })
        this.rederive()
      },
    }
  }

  /**
   * The worker the map's correlation toggle runs on, opened on first use.
   *
   * **A client of its own, not the analysis panel's.** The runner's client
   * belongs to `analysis/workspace.ts` and lives and dies with the drawer, so a
   * map whose correlation vanished because somebody folded a panel away would be
   * a coupling nobody could see. It is also the wrong *queue*: a correlation
   * would sit behind whatever insulation pass the reader started, and the map
   * would wait minutes on work it has nothing to do with.
   *
   * Lazy for {@link AnalysisClient}'s own reason — the worker pulls in a chunk
   * measured in megabytes, and a reader who never turns this on never pays for
   * it. **Never opened**, either: `correlate` is the one request that needs no
   * mount, so this thread holds no file handle and no range cache.
   */
  private correlator: AnalysisClient | null = null

  /**
   * Correlate a square the view is holding, off the main thread.
   *
   * The array is *copied* into the worker rather than transferred: transferring
   * would neuter the block the heatmap is drawing from, which is the one
   * optimisation here that would blank the map.
   */
  private correlate(
    values: Float32Array,
    n: number,
    onProgress?: (done: number, total: number) => void,
  ): Cancellable<CorrelationField> {
    this.correlator ??= new AnalysisClient()
    return this.correlator.cancellable<'correlate'>({ kind: 'correlate', values, n }, onProgress)
  }

  /**
   * Run the adaptive despeckle on the analysis thread.
   *
   * {@link correlate}'s twin, on the same client and for the same reason: the
   * work is measured in seconds on a large block, and §18.3 gives that thread
   * exactly this shape of job so the thread answering frames never queues behind
   * one.
   */
  private smooth(request: SmoothingRequest): Cancellable<SmoothedField> {
    this.correlator ??= new AnalysisClient()
    return this.correlator.cancellable<'smooth'>({
      kind: 'smooth',
      values: request.values,
      counts: request.counts,
      over: request.over,
      nrows: request.nrows,
      ncols: request.ncols,
      spec: request.spec,
    })
  }

  /** What every map view needs to build its score picker. */
  private scoreProps(state: ViewState): {
    hasWeights: boolean
    scoreColumns: readonly string[]
    score?: string
  } {
    const info = this.file?.info
    return {
      hasWeights: info?.hasWeights === true,
      scoreColumns: info?.scoreColumns ?? ['count'],
      ...(state.score === undefined ? {} : { score: state.score }),
    }
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
      this.assemblySource = null
      this.mounted = null
      this.breadcrumb = null
      this.breadcrumbHost.replaceChildren()
      // The annotation worker belongs to the open file, and there is no longer
      // one. Its cache is megabytes of parsed features; leaving it running would
      // hold them until the tab closed.
      this.annotations?.client.destroy()
      this.annotations = null
      this.manualCard = null
      this.metadataCard = null
      this.bookmarksCard = null
      // Destroyed rather than dropped: it holds a `ResizeObserver` and a
      // text-scale subscription, and `setGeneral([])` below replaces the column
      // without telling anything in it that it is going.
      this.minimap?.destroy()
      this.minimap = null
      // The second file too, and for the same reason: it is a second map *of a
      // file that is no longer open*, and with no state there is no `uri2` left
      // to reconcile against — so nothing downstream would ever reach it again,
      // and its worker would sit on an h5wasm instance and an open handle for as
      // long as this tab stayed on the picker. Every other teardown here already
      // released it; this was the one that did not.
      this.dropCompare()
      this.compareCard = null
      // …and every companion panel, each of which is another worker on another
      // file of the same shape. A deck is a picture *beside* this session's
      // file, and there is no longer one for it to be beside.
      this.deck?.destroy()
      this.deck = null
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
      // The map this session is already holding, asked for as tracks. The Back
      // button reaches this — hiding the map pushes a `view=browser` entry, so
      // going forward to it again arrives here — and so does a shared link. Put
      // the map down rather than closing and re-opening the file, which is both
      // slower and lossy.
      if (this.file?.uri === state.uri && this.canHideMap) {
        this.hideMap()
        return
      }
      if (this.opening !== null || this.resolving !== null) return
      const source = await this.sourceFor(state.uri)
      if (this.destroyed || this.store.state !== state) return
      if (source === null) {
        this.showContent(this.pickerWithNote(state.uri))
        return
      }
      await this.openGenome(state.uri, source, state.locus, true)
      return
    }

    // …and the way back. A parked map has an assembly *and* a file, so any
    // state that is not the browser's is the map being asked for again — by the
    // Back button, or by a card that navigated. Unpark before anything below
    // reads `assembly` and concludes this is still a browser.
    if (this.parkedMap !== null && this.file?.uri === state.uri) {
      this.parkedMap = null
      this.assembly = null
      this.browser = null
      this.annotations?.store.turnAxesForBrowser()
      // The same live-card rebuild {@link showMap} does, for the other door back.
      this.paintSequences()
      this.setGeneral(this.infoPanel === null ? [] : [this.infoPanel.el])
      this.syncCompareCard()
      this.mounted = null
      this.host.sessionChanged(this)
    }

    if (this.file === null || this.file.uri !== state.uri) {
      if (this.opening !== null || this.resolving !== null) return
      const source = await this.sourceFor(state.uri)
      if (this.destroyed || this.store.state !== state) return
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
      this.navigate({ ...state, balance: undefined }, { replace: true })
      return
    }

    if (state.view === 'genomes' && !this.file.info.hasGenomes) {
      // An scool's landing table is its cells, and `genomes` is the default a
      // hash with no `view` in it parses to — so without this, dropping one or
      // following a bare link to one arrived on Chromosomes, past the table the
      // file exists to offer. A cooler has no such table and keeps going to
      // its chromosomes, which is the case this redirect was written for.
      const instead = this.isScool ? 'cells' : 'contigs'
      this.navigate({ ...state, view: instead }, { replace: true })
      return
    }

    // The mirror, for a link that names a cells table on a file that has none.
    // Every other container answers `cells` with an empty view and no way off
    // it, which is the failure this whole block exists to prevent.
    if (state.view === 'cells' && !this.isScool) {
      this.navigate(
        { uri: state.uri, view: this.file.info.hasGenomes ? 'genomes' : 'contigs' },
        { replace: true },
      )
      return
    }

    // The same rewrite for the other view a cooler cannot answer. `overview`
    // scans for a genome × genome matrix, and a file with no genome layer has
    // none — but it does have the other half of the same menu entry, the whole
    // map in one bounded read, which is what "Whole genome" means there.
    if (state.view === 'overview' && !this.file.info.hasGenomes) {
      this.navigate({ uri: state.uri, view: 'whole' }, { replace: true })
      return
    }

    // …and the mirror of it. A metagenome's whole-file map is the `bin` level of
    // `overview` rather than a view kind of its own (§7.3), so a link naming the
    // cooler's kind lands on the one this file has, at the level it asked for —
    // `matrixLevel` because that is what `whole` would have drawn. Without this
    // the picker in the sidebar there would patch a level nothing routes on.
    if (state.view === 'whole' && this.isMetacool) {
      this.navigate({ ...state, view: 'overview', level: matrixLevel(state) }, { replace: true })
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
    // Only a *remote* second file is in the state, because only a remote one
    // can be re-opened from a link (§11) — so a local comparison is invisible
    // here, and reading its absence as "put it down" is exactly what happened:
    // `openCompare` finished, called `remount`, and this line threw the file
    // away again before it could be drawn. A local comparison is left alone; the
    // × on the card is what closes it, and that goes through `closeCompare`.
    const shareable = this.compare !== null && this.compare.source.kind === 'remote'
    const held = shareable ? (this.compare?.uri ?? null) : null
    // …and nothing at all while a second file is being **carried across a
    // change of resolution**. This runs during the open — the first file is
    // read, its annotations are rebuilt, and both of those are awaits — and the
    // state it reconciles against is still the one being left, whose `uri2`
    // names the previous rung. Acting on it opens the second file at the bin
    // size the reader has just moved away from, and the gate refuses the pair
    // it has itself just assembled: the comparison is on screen, and the card
    // beside it says the two files' resolutions differ.
    if (wanted !== held && this.compareCarry === null) {
      if (wanted === null) {
        if (shareable) this.dropCompare()
      } else {
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

    // …and the half the hash never carried. A local comparison this session
    // wrote down is re-opened here, once, when nothing is holding the triangle
    // — which is the state a reload leaves. Guarded on `compareOpening` as well
    // as on `compare`, because the open is asynchronous and `render` runs many
    // times before it lands; without it a reload would start the same file four
    // times and each would terminate the last one's worker.
    if (
      this.compare === null &&
      this.compareOpening === null &&
      this.compareCarry === null &&
      state.uri2 === undefined
    ) {
      const local = recall<string>(this.memoryKey(state.uri), 'compare:local')
      if (typeof local === 'string' && local !== '') void this.reopenCompare(local)
    }

    // …and the same reconciliation for the deck (§16), one line lower because
    // it is the same question asked of N files rather than of one: the hash
    // names the companions, and this is where a pasted link, a restored tab and
    // a panel opened by hand all arrive. Before the repaint short-circuit
    // below, because a deck follows the *view* and a colour-only change is
    // still a view its panels have to be handed — a link that pins `vmax` and
    // nothing else must not leave four maps unreconciled.
    await this.syncDeck(state)

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
    //
    // A *derivation* (§7.5) takes the same road for the same reason and one
    // more: it is arithmetic over cells already in memory, so rebuilding to
    // apply it would pay a worker round trip for nothing — and on a gated
    // whole-genome map it would put the scan back behind its button.
    if (
      this.mounted !== null &&
      this.current !== null &&
      differsOnlyInPresentation(this.mounted, state)
    ) {
      this.current.applyScale?.(this.scaleOf(state))
      this.rederive()
      // …and stand back on the saved place, if the view is at one. Turning a map
      // re-cuts it and therefore refits it — which the reader asked for, and which
      // on a focused view meant pressing the turn toggle at a bookmark threw you
      // back to the whole chromosome. `rederive` is synchronous, so the place is
      // restored in the same frame as the shape and nothing flashes.
      this.current.showFocus?.(state.focus)
      this.mounted = state
      this.breadcrumb?.render(state)
      this.host.activity(this)
      return
    }

    // Going to a second saved place on the same chromosome is a *zoom*, not a
    // navigation (§8.10). The block on screen already covers it — that is what
    // `focus` means, a window over a region read whole — so rebuilding the view
    // would pay a worker round trip and a re-read of the picture already in front
    // of the reader, for a change of transform. Walking a BED of forty peaks made
    // that forty reads of one chromosome.
    //
    // Guarded on `showFocus` rather than on the view kind, so a view that has no
    // diagonal to stand a locus on falls through to the rebuild and lands
    // wherever the hash actually says.
    if (
      this.mounted !== null &&
      this.current?.showFocus !== undefined &&
      differsOnlyInFocus(this.mounted, state)
    ) {
      this.current.showFocus(state.focus)
      this.mounted = state
      this.breadcrumb?.render(state)
      this.host.activity(this)
      return
    }

    this.breadcrumb?.render(state)
    this.breadcrumbHost.replaceChildren(this.breadcrumb?.el ?? el('div'))
    // Before the view mounts, because the view is what issues the reads and a
    // block drawn from the previous set would be a picture of the wrong cells.
    await this.syncCells(state)
    if (this.destroyed || this.store.state !== state) return
    this.mounted = state

    switch (state.view) {
      case 'genomes':
        this.mountGenomes(state)
        break
      case 'cells':
        await this.mountCells(state)
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
    // …and for the same reason, since the ticks are read against that table: a
    // link straight to a region arrives before anything has opened one.
    this.syncSequenceTicks(state)
    // Here rather than beside the mount, because a *pan* mounts nothing: the
    // browser reports its window into the store (`onLocusChange`), which comes
    // back through this same path, so this is the one place a jump and a drag
    // are both visible.
    this.syncMinimap(state)
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
   *
   * **Nothing at all on a cooler.** The *Chromosome* card there described the
   * one sequence the breadcrumb already names, from a table the reader can open
   * in full, and it took the room the Sequences card now uses to say the same
   * thing about every chromosome at once with a way to change it
   * ({@link paintSequences}). A metacool keeps its *Contig* card: its picker is
   * the genomes table, so the contig on screen is the fact the panel has left to
   * report — and the genome it belongs to, which the card resolves by name.
   */
  private recordsFor(state: ViewState): RecordSpec[] {
    const file = this.file
    if (file === null) return []
    if (!file.info.hasGenomes) return []
    const noun = 'Contig'
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
      icon: 'dna',
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
      icon: 'list',
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
      file: this.mapLabel(state.uri),
      ...(state.genome === undefined ? {} : { genome: state.genome }),
    }
  }

  private mountGenomes(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const view = new GenomesTable({
      data: file.genomes,
      persistence: this.tableMemory(state.uri, 'genomes'),
      onOpenGenome: (genome) => this.navigate({ uri: state.uri, view: 'genome', genome }),
      onOpenSelection: (names) =>
        this.navigate({ uri: state.uri, view: 'selection', genomes: names.join(',') }),
      onOpenWhole: () => this.navigate({ uri: state.uri, view: this.wholeFileView() }),
      // Straight to the window, past the two whole-something doors beside it.
      // No `genome` on the state: the reader resolves a genome name, a contig
      // name and either with coordinates on it, so what was typed decides which
      // of those it was — guessing here would be this method answering a
      // question `parseMetacoolerRange` is about to answer properly.
      onOpenRegion: (region) => this.navigate({ uri: state.uri, view: 'region', region }),
    })
    this.showContent(view.el, view)
  }

  /**
   * The cells table of an `.scool` (§3.8), fetched on first sight.
   *
   * Ticking rows does two things at once, and that is the view's whole design:
   * it names the picture to draw *and* sets which cells the file is read
   * through from here on. So the navigation carries both — a whole-genome view
   * of the sum, and the set itself, which every view the reader moves to next
   * inherits until they come back here and change it.
   */
  /**
   * Take a per-cell QC result into the Cells table's columns (§3.8).
   *
   * Held by uri rather than by open file, so walking into a cell and back out —
   * or opening another tab and returning — keeps the numbers. They are a
   * measurement of the file, and the file has not changed.
   *
   * The table is rebuilt only when it is the view on screen; otherwise the
   * columns are simply there the next time somebody navigates to it, which is
   * the moment they are wanted.
   */
  private adoptCellMeasurements(uri: string, table: TableOutput): void {
    // The fractions only. `contacts` and `nnz` are already columns of this table
    // from the file's own attributes, and a second pair beside them differing in
    // the third decimal — because one counts records and the other sums a
    // balanced value — is two numbers for one thing and no way to tell which.
    const fractions = table.columns.filter(
      (column) => column.kind === 'number' && column.key !== 'contacts' && column.key !== 'nnz',
    )
    const values = new Map<string, Record<string, number>>()
    for (const row of table.rows) {
      const name = row['cell']
      if (typeof name !== 'string') continue
      const held: Record<string, number> = {}
      for (const column of fractions) {
        const value = row[column.key]
        if (typeof value === 'number') held[column.key] = value
      }
      values.set(name, held)
    }
    if (values.size === 0) return
    this.cellMeasured.set(uri, {
      columns: fractions.map((column) => ({
        key: column.key,
        label: column.label,
        ...(column.hint === undefined ? {} : { hint: column.hint }),
      })),
      values,
      from: 'the per-cell contact QC task',
    })
    if (this.store.state?.view === 'cells' && this.store.state.uri === uri) {
      void this.mountCells(this.store.state)
    }
  }

  private async mountCells(state: ViewState): Promise<void> {
    const file = this.file
    if (file === null) return
    const data = await this.cells()
    if (this.destroyed || this.store.state !== state) return
    const total = data.table.length
    const show = (names: readonly string[] | null): void => {
      this.navigate({
        uri: state.uri,
        view: this.wholeFileView(),
        ...cellsPatch(names, total),
      })
    }
    const measured = this.cellMeasured.get(state.uri)
    const view = new CellsTable({
      data,
      ...(measured === undefined ? {} : { measured }),
      persistence: this.tableMemory(state.uri, 'cells'),
      onShowCells: (names) => show(names),
      onShowAll: () => show(null),
    })
    this.showContent(view.el, view)
  }

  /**
   * Per-cell numbers a QC run measured, by uri (§3.8).
   *
   * Not on the open file, because it outlives one: a reader runs the task, walks
   * into a cell to look at it, and comes back to the table expecting the columns
   * that sent them there to still be on it.
   */
  private readonly cellMeasured = new Map<string, MeasuredCells>()

  /** The cells table payload, read once per open file. */
  private async cells(): Promise<CellsResult> {
    const file = this.file
    if (file === null) throw new Error('no file open')
    if (file.cells === null) {
      file.cells = await this.clientOf().request<'cells'>({ kind: 'cells' })
    }
    return file.cells
  }

  /**
   * Put the worker on the cell set this state names, before anything reads.
   *
   * The one piece of worker state a *navigation* can change, and the reason it
   * is reconciled here rather than sent with each read: a cell set is a property
   * of the open map, so a matrix, a scan and a pooled aggregation over the same
   * set must all see the same one, and threading it through every request kind
   * would give six places for the two to disagree.
   *
   * A no-op when the set has not moved, which is every navigation but the ones
   * through the cells table — so panning, zooming and stepping into a
   * chromosome cost nothing at all.
   */
  private async syncCells(state: ViewState): Promise<void> {
    const file = this.file
    if (file === null || file.info.cells.length === 0) return
    const wanted = cellsOf(state)
    const resolved = wanted ?? file.info.cells
    const current = file.activeCells
    if (current !== null && sameNames(current, resolved)) return
    const result = await this.clientOf().request<'selectCells'>({
      kind: 'selectCells',
      names: wanted === null ? null : [...wanted],
    })
    if (this.destroyed) return
    file.activeCells = result.names
    // The score picker is per cell set, not per file: a column one cell of the
    // set lacks cannot be summed across it (`metacooler/scool.ts`).
    file.info = {
      ...file.info,
      activeCells: result.names,
      cellNnz: result.nnz,
      scoreColumns: result.scoreColumns,
    }
    // The panel is painted once at open, because a file's facts do not move —
    // except these two, which are the reader's own choice and the cost it
    // implies. Without this it went on reporting the whole file's pixel count
    // over a map summed from two of its cells.
    this.infoPanel?.refresh(file.info)
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
    // …and on one, the landing view gets the 1D browser's bar over the table: a
    // ruler of the whole assembly that a drag names a window in. Withheld on a
    // metacool, where the same strip is a hundred thousand sub-pixel bands with
    // no name in any of them — see `ContigsTableOptions.assembly`.
    const assembly = cooler ? this.assemblyOfFile(file) : null
    const toggle = assembly === null ? undefined : this.mapToggleButton()
    const view = new ContigsTable({
      data,
      hideColumns: cooler ? ['genome_id'] : [],
      title: cooler ? 'Chromosomes' : 'Contigs',
      hint: cooler
        ? 'One genome, its chromosomes. Pick one to see its map, or select a subset to compare them.'
        : undefined,
      ...(assembly === null ? {} : { assembly }),
      ...(this.annotations === null ? {} : { store: this.annotations.store }),
      ...(toggle === undefined ? {} : { extraControl: toggle }),
      persistence: this.tableMemory(state.uri, 'contigs'),
      onOpenContig: (contig) =>
        this.navigate({ uri: state.uri, view: 'region', region: contig, genome: state.genome }),
      // The same destination a click on a row reaches, with coordinates on it —
      // and offered on a MAG's contig list too, where "open the whole contig
      // first" is exactly as expensive a detour as it is at the top level.
      onOpenRegion: (region: string) =>
        this.navigate({ uri: state.uri, view: 'region', region, genome: state.genome }),
      // Neither while this table is one genome's contigs: "the whole file" is
      // not the question someone reading a MAG's contigs is asking, and the map
      // of *those* contigs is the genome view one crumb up.
      ...(state.genome === undefined
        ? {
            onOpenWhole: () => this.navigate({ uri: state.uri, view: this.wholeFileView() }),
            onOpenSelection: (names: string[]) =>
              this.navigate({ uri: state.uri, view: 'selection', regions: names.join(',') }),
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
    // On a metagenome this view is one level of the whole-file picker rather
    // than a view of its own (see {@link mountOverview}), so it carries that
    // picker and not the panel's two-entry one — which would sit beside it
    // offering a *second* `contig`, meaning the roll-up of this read rather
    // than the scan the other level draws.
    const picker = this.isMetacool
    this.mountWholeFile(
      state,
      `whole|${state.uri}|${this.compareKey()}|${level}|${String(balance)}`,
      () => {
        const mapSwitch = this.mapToggleButton()
        return new WholeView({
          client: this.clientOf(),
          caption: this.captionFor(state),
          ...(mapSwitch === undefined ? {} : { extraControl: mapSwitch }),
          ...(picker
            ? {
                wholeFileLevel: {
                  card: wholeFileLevelCard(level, (next) =>
                    this.store.patch({ level: next }, { replace: true }),
                  ),
                  onOpenGenome: (genome: string) =>
                    this.navigate({ uri: state.uri, view: 'genome', genome }),
                  // The same two destinations the overview's own cells open,
                  // through the same navigation: one MAG's map on the diagonal,
                  // the block between two off it.
                  onOpenPair: (genome: string, genome2: string) =>
                    this.navigate({ uri: state.uri, view: 'pair', genome, genome2 }),
                },
              }
            : {}),
          binsize: file.info.binsize ?? 1,
          rungs: file.info.entries,
          nBins: file.info.nBins,
          nContigs: file.info.nContigs,
          displayExtent: file.info.displayExtent,
          // The file's own count of stored pixels, which is what the read walks.
          // A cooler that does not declare it is not gated rather than gated on
          // a guess; the same number is in the File card, from the same place.
          nnz: file.info.cellNnz ?? numberOr(file.info.info['nnz']),
          level,
          scale: this.scaleOf(state),
          balance,
          ...this.scoreProps(state),
          // Offered for a cooler too, now that the roll-up accumulates from the
          // stored pixels: a chromosome-level whole-genome view of yeast is
          // 17 x 17 cells and always fits, which makes it the honest answer when
          // the bin-level block does not. It is only meaningless on a file with
          // one sequence, where every level is a single cell — and on a
          // metagenome, where the card above already offers all three.
          offerLevel: !picker && file.info.nContigs > 1,
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
          onScoreChange: (choice) => this.setScore(choice),
          derive: this.derivePresentation(state),
          turn: this.turnPresentation(state),
          onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
          onOpenRegion: (region, region2) =>
            this.navigate({
              uri: state.uri,
              view: 'region',
              region,
              ...(region2 === undefined ? {} : { region2 }),
            }),
          onError: (err) => this.showError(err),
        })
      },
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
      this.navigate({ uri: state.uri, view: this.wholeFileView() }, { replace: true })
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
    const contigs = this.contigsOfSelection(selection)
    const mapSwitch = this.mapToggleButton()
    const view = new WholeView({
      client: this.clientOf(),
      caption: this.captionFor(state),
      ...(mapSwitch === undefined ? {} : { extraControl: mapSwitch }),
      binsize: file.info.binsize ?? 1,
      rungs: file.info.entries,
      nBins: file.info.nBins,
      nContigs: file.info.nContigs,
      displayExtent: file.info.displayExtent,
      nnz: file.info.cellNnz ?? numberOr(file.info.info['nnz']),
      level: 'bin',
      scale: this.scaleOf(state),
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      // No level toggle: the roll-up reads a bin range, and a selection is not
      // one. The sequences are already the axis at bin level here.
      offerLevel: false,
      noun: file.info.hasGenomes ? 'contig' : 'chromosome',
      ...(this.annotationContext() === undefined
        ? {}
        : { annotations: this.annotationContext() }),
      ...(this.compareContext() === undefined ? {} : { compare: this.compareContext() }),
      namesGenomes: file.info.hasGenomes,
      selection: { ...selection, bins, contigs },
      onLevelChange: () => {},
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      // A selection of several genomes is divided and labelled by genome, so an
      // axis label here is a MAG and the gesture on it is the one the genomes
      // table's own rows answer. The same navigation, so the two doors into a
      // genome are one door. Passed whatever was ticked: a selection of contigs
      // never reaches it, because the reader only marks the genome runs as the
      // axis when genomes were the thing chosen.
      onOpenGenome: (genome) => this.navigate({ uri: state.uri, view: 'genome', genome }),
      onOpenRegion: (region, region2) =>
        this.navigate({
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

  /**
   * How many sequences a selection covers — the other half of what its grid is
   * planned against.
   *
   * Every sequence starts a cell of its own, so the sequence count is the floor
   * on the axis however coarse the bins are made, and a plan that ignores it
   * asks for a picture larger than the one that can be drawn.
   */
  private contigsOfSelection(selection: UnitSelection): number {
    const file = this.file
    if (file === null) return 0
    if (selection.kind === 'contig') {
      const lengths = contigLengths(file.contigs)
      return selection.names.filter((name) => lengths.has(name)).length
    }
    const names = file.genomes.table.data['name']
    const counts = file.genomes.table.data['n_contigs']
    if (!Array.isArray(names) || counts === undefined || Array.isArray(counts)) return 0
    let contigs = 0
    for (const name of selection.names) {
      const row = (names as string[]).indexOf(name)
      if (row >= 0) contigs += Number(counts[row])
    }
    return contigs
  }

  private mountGenome(state: ViewState): void {
    if (state.genome === undefined) {
      this.navigate({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const view = new GenomeView({
      client: this.clientOf(),
      ...(this.annotationContext() === undefined ? {} : { annotations: this.annotationContext() }),
      caption: this.captionFor(state),
      binsize: this.file?.info.binsize ?? 1,
      rungs: this.file?.info.entries,
      genome: state.genome,
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      ...(this.circularPresentation(state) === undefined
        ? {}
        : { circular: this.circularPresentation(state) }),
      neighbours: { prev: this.stepTarget(-1), next: this.stepTarget(1) },
      onStep: (delta) => this.step(delta),
      level: matrixLevel(state),
      scale: this.scaleOf(state),
      onLevelChange: (level) => this.store.patch({ level }, { replace: true }),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenRegion: (region) =>
        this.navigate({ uri: state.uri, view: 'region', region, genome: state.genome }),
      onOpenContigPair: (region, region2) =>
        this.navigate({ uri: state.uri, view: 'region', region, region2, genome: state.genome }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  private mountPair(state: ViewState): void {
    const file = this.file
    if (file === null) return
    if (state.genome === undefined || state.genome2 === undefined) {
      this.navigate({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const mapSwitch = this.mapToggleButton()
    const view = new PairView({
      client: this.clientOf(),
      ...(this.annotationContext() === undefined ? {} : { annotations: this.annotationContext() }),
      caption: this.captionFor(state),
      ...(mapSwitch === undefined ? {} : { extraControl: mapSwitch }),
      binsize: file.info.binsize ?? 1,
      rungs: file.info.entries,
      genomeNames: file.displayNames,
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      rowGenome: state.genome,
      colGenome: state.genome2,
      level: matrixLevel(state),
      scale: this.scaleOf(state),
      onChangeGenomes: (genome, genome2) => this.navigate({ ...state, genome, genome2 }),
      onLevelChange: (level) => this.store.patch({ level }, { replace: true }),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenGenome: (genome) => this.navigate({ uri: state.uri, view: 'genome', genome }),
      onOpenContig: (region, region2) =>
        this.navigate({
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
      this.navigate({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    // The contigs table is what "next contig" steps through. It is read once
    // per file and cached, so this costs a read on the first region view and
    // nothing afterwards.
    if (this.file?.contigs == null) await this.contigs().catch(() => null)
    if (this.destroyed || this.store.state !== state) return
    const mapSwitch = this.mapToggleButton()
    const keep = this.bookmarkButton()
    const view = new RegionView({
      client: this.clientOf(),
      caption: this.captionFor(state),
      ...(mapSwitch === undefined ? {} : { extraControl: mapSwitch }),
      ...(keep === undefined ? {} : { boxControl: keep }),
      binsize: this.file?.info.binsize ?? 1,
      rungs: this.file?.info.entries,
      region: state.region,
      noun: this.file?.info.hasGenomes === false ? 'chromosome' : 'contig',
      ...(this.annotationContext() === undefined ? {} : { annotations: this.annotationContext() }),
      ...(this.compareContext() === undefined ? {} : { compare: this.compareContext() }),
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      ...(this.circularPresentation(state) === undefined
        ? {}
        : { circular: this.circularPresentation(state) }),
      neighbours: { prev: this.stepTarget(-1), next: this.stepTarget(1) },
      onStep: (delta) => this.step(delta),
      ...(state.region2 === undefined ? {} : { region2: state.region2 }),
      ...(state.focus === undefined ? {} : { focus: state.focus }),
      scale: this.scaleOf(state),
      // Typing a new region replaces the whole selection, so the second axis
      // goes with it: `contig_A × contig_B` then `contig_C` means contig_C, not
      // contig_C against a column the user can no longer see named anywhere.
      // Built by omission rather than `region2: undefined`, so the state object
      // has no undefined-valued keys for a strict deep-equal to trip on.
      //
      // …and the saved place goes with it too, for a stronger reason: a `focus` is
      // a window *inside* a named region, so the moment the region changes it
      // names a stretch of somewhere the reader is no longer looking. Left in, a
      // selection drawn on a bookmarked chromosome opened the new block and then
      // yanked it back to the old bookmark.
      onChangeRegion: (region, region2) => {
        const { region2: _dropped, focus: _left, ...rest } = state
        this.navigate({ ...rest, region, ...(region2 === undefined ? {} : { region2 }) })
      },
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenGenome: (genome) => this.navigate({ uri: state.uri, view: 'genome', genome }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  /**
   * The sidecar genome edge list this file advertises, if any.
   *
   * A query parameter rather than view state: it describes where the file is
   * published, not which picture of it is on screen. Read in one place because
   * two now ask — the scan view, which offers the download, and the default
   * level, which steps aside for it.
   */
  private edgeListUrl(): string | undefined {
    return new URLSearchParams(window.location.search).get('edges') ?? undefined
  }

  /** The whole-metagenome scan (§7.3), mounted like any other view. */
  private mountOverview(state: ViewState): void {
    const file = this.file
    if (file === null) return
    // A published edge list is a genome × genome overview for one small
    // download instead of a pass over the file, so where one is advertised
    // *that* is the cheapest thing to land on and the default gives way to it.
    // Only the default: a link that names a level has already chosen.
    const edgeListUrl = this.edgeListUrl()
    const level =
      state.level === undefined && edgeListUrl !== undefined ? 'genome' : overviewLevel(state)
    // Three levels, two classes. `bin × bin` is not an accumulation over pairs
    // of units — it is the pooled whole-file read {@link WholeView} already
    // makes, and on a metagenome it is the same picture as ticking every row of
    // the genomes table. Routed here rather than left as a second view to
    // navigate to, so the three are one choice in one control (§7.3).
    if (level === 'bin') {
      this.mountWhole(state)
      return
    }
    this.mountWholeFile(
      state,
      `overview|${state.uri}|${level}`,
      () =>
        new Overview({
          client: this.clientOf(),
          ...(this.annotationContext() === undefined ? {} : { annotations: this.annotationContext() }),
          caption: this.captionFor(state),
          binsize: file.info.binsize ?? 1,
          sourceKind: file.info.sourceKind,
          sourceBytes: file.info.sourceBytes,
          ...(edgeListUrl === undefined ? {} : { edgeListUrl }),
          level,
          scale: this.scaleOf(state),
          genomeNames: file.displayNames,
          onLevelChange: (next) => this.store.patch({ level: next }, { replace: true }),
          onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
          onOpenPair: (a, b) =>
            this.navigate({ uri: file.uri, view: 'pair', genome: a, genome2: b }),
          onOpenGenome: (genome) => this.navigate({ uri: file.uri, view: 'genome', genome }),
          onOpenContig: (region, region2) =>
            this.navigate({
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
      focusSearch: () => view.focusSearch(),
    })
  }

  // -------------------------------------------------------------------------
  // Navigating
  // -------------------------------------------------------------------------

  /**
   * Go somewhere in this session, keeping what is on screen beside the view.
   *
   * Every navigation builds a **fresh** state — `{ uri, view: 'contigs' }` and
   * nothing else — and that is right for what a navigation is: the region, the
   * genome, the level and the pair are all facts about the picture being left
   * behind. {@link COMPANION_KEYS} are not. A deck of other files (§16) and a
   * second file in the lower triangle (§5.7) are things the reader put on
   * screen *around* this session, and no navigation within one file is a
   * request to take them away.
   *
   * Left to `store.set` alone they were taken away by every one of them.
   * Clicking Chromosomes and then a contig — the plainest way there is to look
   * at another chromosome — arrived with no `maps`, the deck reconciled itself
   * to nothing, and five workers were released on the way past a table. The
   * companions are held *in the state* rather than in a field precisely so a
   * link carries them, which is what made the loss silent: nothing was left
   * holding them once the key had gone.
   *
   * **Same file, by path and not by URI.** A resolution is a group inside one
   * `.mcool` (§3.4), so `…::resolutions/1000` and `…::resolutions/2000` are one
   * file at two levels and a deck spans them — changing the resolution is the
   * case this most obviously must survive. A different *path* is a different
   * file, this session is now of something else, and a deck assembled beside
   * the old one has no claim on it.
   *
   * Deliberately **not** in the store: the address bar is obeyed exactly as
   * written. A pasted link with no `maps` in it means a deck of one, and a
   * store that helpfully put the last one back would show the recipient
   * something nobody sent (`App.render`).
   */
  /** @returns whether the store actually moved, so a caller can render by hand. */
  private navigate(next: ViewState | null, options: { replace?: boolean } = {}): boolean {
    const carried = next === null ? null : this.withCompanions(next)
    const moved = !viewStateEquals(carried, this.store.state)
    this.store.set(carried, options)
    return moved
  }

  /** {@link navigate}'s carrying rule, as a value. */
  private withCompanions(next: ViewState): ViewState {
    const held = this.store.state
    if (held === null || splitUri(held.uri).path !== splitUri(next.uri).path) return next
    const out = { ...next }
    // `in`, not `!== undefined`: a caller that has said something about a key is
    // believed, including having said it is gone. That is what lets the deck put
    // itself down (`onMapsChange(undefined)`) and the compare card close its
    // file, without either having to know this rule exists — and what lets a
    // reader who asked for the square keep it, `flip: false` being a thing said.
    const carry = <
      K extends
        | (typeof COMPANION_KEYS)[number]
        | (typeof READING_KEYS)[number]
        | (typeof SUBJECT_KEYS)[number],
    >(
      key: K,
    ): void => {
      if (key in next) return
      const value = held[key]
      if (value !== undefined) out[key] = value
    }
    for (const key of COMPANION_KEYS) carry(key)
    for (const key of READING_KEYS) carry(key)
    for (const key of SUBJECT_KEYS) carry(key)
    return out
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
    else this.navigate(null)
  }

  private showContent(
    node: HTMLElement,
    view?: {
      destroy?(): void
      applyScale?(scale: ScaleState): void
      /** For a view that can be moved to a saved place rather than rebuilt (§8.10). */
      showFocus?(region: string | undefined): void
      sideEl?: HTMLElement
      panel?: MatrixPanel
      /** For a view that owns a canvas but not a {@link MatrixPanel}. */
      remeasure?(): void
      /** The box `/` puts the caret in, for a view that has one. */
      focusSearch?(): void
    },
  ): void {
    this.current?.destroy?.()
    this.current = view ?? null
    // Whichever stop of the map/tracks cycle we are at, applied to the panel
    // that has just been built. Here rather than in the four views that own a
    // panel: they are handed a picture to draw, and which furniture goes round
    // it is the session's answer — the same reason the toggle itself lives here.
    view?.panel?.showLanes(!this.mapOnly)
    // "Click the map" is only offered while there is a map. A table view has
    // none, and a button that arms a gesture nothing can complete is worse than
    // one that is plainly unavailable.
    this.manualCard?.refresh()
    // …and the same for *this view*, which saves the window on screen and has none
    // to save on a table.
    this.bookmarksCard?.refresh()
    // What the metadata drop-down offers is what *this* view can show (§8.12):
    // a genome × genome overview cannot draw a bin weight, and a card that went
    // on offering one would be offering a lane that never appears. So it is
    // refreshed with every navigation, exactly as the two above are.
    this.metadataCard?.refresh()
    // The deck, where there is one, is a frame around whatever was going to be
    // mounted: the view's own element is *re-parented* into the first cell of a
    // grid rather than rebuilt, so a session with companions costs the session
    // it would have been plus the companions (§16.1).
    this.contentNode = node
    // …but only for a view the companions can answer. A table or an overview is
    // of *this file* and nothing else, so framing one put a genomes table into
    // one sixth of the column beside five rectangles each saying it has nothing
    // to draw. The deck is kept — navigating back to a map must not cost five
    // files reopened — it simply stops being a frame while there is nothing for
    // it to be a frame around.
    this.contentEl.replaceChildren(this.framed(node))
    this.deck?.setLead(view?.panel ?? null)
    // Emptied rather than hidden when a view has no controls: a table view
    // offers no aesthetics, so the column leaves the layout and its button goes
    // with it — the same rule the other two follow.
    this.setAesthetics(view?.sideEl === undefined ? [] : [view.sideEl])
    // After the view is mounted, because the framing and the block a task runs
    // on are read off whatever is on screen *now* (§18.4) — and because a table
    // view has neither, which is a state the panel has to be able to show.
    this.syncAnalysis()
  }

  /** The picker, asking for the file a config describes. */
  private pickerWithConfig(config: SessionConfig): HTMLElement {
    const tracks = config.tracks.length
    // What the session knows about the file, when it knows anything. `rep1.cool`
    // is a name a reader may have several of, and the size and date are the
    // difference between finding the right file and finding *a* file with the
    // right name. Absent for every session written before the field existed and
    // for every one made from a remote file, and then the sentence is the one it
    // has always been.
    const note = sourceNote(config.source)
    return el(
      'div',
      { class: 'view' },
      el('p', {
        class: 'inline-error',
        text:
          `This session was saved from ${fileLabel(config.state.uri)}` +
          (note === null ? '' : ` (${note})`) +
          ', which is a local file — no ' +
          'page can re-open one by name. Drop it below and everything else comes back with it' +
          (tracks === 0 ? '.' : `: the view, and ${fmt.int(tracks)} tracks with their settings.`),
      }),
      this.picker.el,
    )
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
      // The open, run again, after a Google sign-in offered by the view itself
      // (§24.7). Given whenever this failure was about a *file* — the view is
      // what decides whether a sign-in is on offer at all, and it only is for a
      // `401`/`403` from a Google host, so handing it the retry unconditionally
      // adds no button anywhere else.
      onSignedIn:
        uri !== undefined && source !== undefined
          ? () => void this.open(uri, source)
          : undefined,
    })
    this.showContent(view.el)
  }


  // -------------------------------------------------------------------------
  // Analysis (§18)
  // -------------------------------------------------------------------------

  /**
   * Build, refresh or drop the analysis surfaces to match what is open.
   *
   * Called after every view mount, because two of the four things a task needs
   * are properties of the picture rather than of the file: the framing it will
   * be a record of, and whether there is a block in memory cheap enough to hand
   * over instead of re-reading (§18.3, §18.4). A table view has neither, and the
   * panel has to be able to say so.
   *
   * The workspace itself outlives a navigation — it holds a worker and possibly
   * a running job, and §18.3 is explicit that a job survives clicking a
   * chromosome — so it is built once per file and only *refreshed* here.
   */
  private syncAnalysis(): void {
    // Keyed on the *context* rather than on a file, because a 1D browser session
    // has no file and still has three tasks it can run (§5.8). What decides the
    // column is whether there is anything at all to analyse.
    if (this.analysisContext() === null) {
      this.analysis?.destroy()
      this.analysis = null
      this.setAnalysis([])
      this.drawerHost.replaceChildren()
      this.syntheticCard = null
      this.renderAnnotations()
      return
    }
    if (this.analysis === null) {
      void this.loadAnalysis()
      return
    }
    this.paintAnalysis(this.analysis)
  }

  /**
   * Fetch the analysis surfaces, the first time a file is open.
   *
   * A dynamic import, in the idiom `ui/FilePicker.ts` already uses for the S3
   * buckets card, and for a reason §18.3 states about the *worker* and which is
   * no less true of the *bundle*: a reader who never opens the panel should pay
   * nothing for it. Statically imported, the drawer, the plot renderers, the
   * form and the two writers were 75 kB of the main chunk — a quarter of it —
   * carried by every session including the ones that only ever look at a map.
   *
   * The cost is that the column appears a frame or two after the view. That is
   * the right trade here: the panel is not what a reader is looking at when a
   * file opens, and nothing else waits on it.
   */
  private async loadAnalysis(): Promise<void> {
    if (this.analysisLoading) return
    this.analysisLoading = true
    try {
      const { AnalysisWorkspace } = await import('../analysis/workspace')
      // Everything below is re-checked because an await is a gap: the tab may
      // have been closed, or the file replaced, while the chunk was in flight.
      if (this.destroyed || this.analysisContext() === null || this.analysis !== null) return
      this.analysis = new AnalysisWorkspace(this.analysisHost_())
      // The workspace brings its own carried rows back through the same `begin`
      // an import goes through, so they arrive on the lead like everything else
      // — and a computed row's map is exactly the fact a batch existed to
      // record. The snapshot is still here, so it is applied again over what the
      // workspace has just added ({@link adoptCarriedLanes}).
      this.adoptCarriedLanes()
      this.paintAnalysis(this.analysis)
    } catch {
      // A chunk that will not load is a viewer with no Analysis column, which
      // is a state the shell already handles — every other panel can be absent
      // too. Not worth an error screen over a feature nothing else depends on.
    } finally {
      this.analysisLoading = false
    }
  }

  private paintAnalysis(analysis: AnalysisWorkspace): void {
    analysis.refresh()
    // The column carries the list; the drawer floats over the body and is the
    // shell's to place, which is why the two are separate hosts.
    this.setAnalysis(analysis.hasTasks ? [analysis.panelEl] : [])
    this.drawerHost.replaceChildren(analysis.drawerEl)
    this.syntheticCard = analysis.syntheticEl
    this.renderAnnotations()
  }

  /** The callbacks `AnalysisWorkspace` reads the session through. */
  private analysisHost_(): AnalysisWorkspaceHost {
    return {
      source: () => {
        const starred = this.starredFacts()
        if (starred !== null) {
          return {
            uri: starred.uri,
            source: starred.source,
            ...cellsOfMap(starred.info),
            ...binningOfMap(starred.info),
          }
        }
        const file = this.file
        if (file !== null) {
          // The ticked cells, so a task measures the map that is drawn rather
          // than the pseudo-bulk of every cell in the file (§3.8). The analysis
          // worker mounts the file for itself and would otherwise have no way to
          // know a selection exists.
          return {
            uri: file.uri,
            source: file.source,
            ...cellsOfMap(file.info),
            ...binningOfMap(file.info),
          }
        }
        // **The genome, where there is no map.** Three tasks run entirely on
        // loaded tracks and a 1D browser session is exactly where a reader has
        // the tracks and not the matrix (§18.3) — `analysisContext` says so and
        // builds them a context, and the runner answers a missing framing with
        // one over the tracks. This was the last line still assuming a matrix:
        // with none, every one of the three failed as *nothing is open*, in the
        // session shape they were written for.
        //
        // Nothing mounts this. A track-only chain never opens a file in the
        // analysis worker (`AnalysisRunner.mount`), so what the pair is for is
        // the record: a result names the file it is a measurement of, and here
        // that is the genome the tracks were loaded against.
        const assembly = this.assembly
        const source = this.assemblySource
        return assembly === null || source === null
          ? null
          : { uri: assembly.uri, source }
      },
      context: () => this.analysisContext(),
      // Read fresh on every call rather than cached: `Run` takes the framing at
      // the instant it is pressed, and a cached one would be a record of
      // wherever the reader happened to be when the drawer opened.
      framing: () => {
        const starred = this.deck?.starredPanel ?? null
        if (starred !== null) {
          const facts = starred.analysisFacts()
          const framed = facts === null ? null : (starred.map?.analysisFraming(facts.uri) ?? null)
          return withCircularNames(framed, this.circularStore()?.list() ?? [])
        }
        const file = this.file
        const panel = this.current?.panel
        return file === undefined || file === null || panel === undefined
          ? null
          : withCircularNames(panel.analysisFraming(file.uri), this.circularStore()?.list() ?? [])
      },
      block: () => {
        const starred = this.deck?.starredPanel ?? null
        if (starred !== null) return starred.map?.analysisBlock() ?? null
        return this.current?.panel?.analysisBlock() ?? null
      },
      store: () => this.annotations?.store ?? null,
      // The same object both surfaces draw groups from, so a suggestion a task
      // makes about its own set (§18.11) means the same thing beside the map and
      // in the 1D browser.
      groups: () => this.annotations?.groups ?? null,
      // The one result that goes to a table rather than to the drawer (§3.8).
      cellMeasurements: (uri, table) => this.adoptCellMeasurements(uri, table),
      // The star, so a measurement lands on the picture it was measured from.
      targetMap: () => this.deck?.starredMap ?? LEAD_MAP,
      // The same list the Tracks card is given, and deliberately not
      // `allTargets` below: that one leaves out a companion whose two tables
      // have not been read, which is right for *running* against it and wrong
      // for *drawing* on it.
      maps: () =>
        this.deck?.mapList ?? [{ id: LEAD_MAP, label: fileLabel(this.file?.uri ?? '') }],
      /**
       * Every map on screen that can be run against **right now**, lead first.
       *
       * A companion appears once it has read the two tables an analysis needs,
       * and the read is kicked off here. That makes this the *synchronous*
       * answer — what the drawer can price, order results by and find the star
       * in — and it is deliberately not what a batch runs on: see
       * {@link allTargetsReady}, which waits.
       */
      allTargets: () => this.readyTargets({ start: true }),
      /**
       * The same list, once every map still opening has answered.
       *
       * This is what **Run on all maps** goes through, and it exists because the
       * synchronous answer above quietly ran on fewer maps than the button said.
       * A companion is a file and a worker: it opens to draw a picture, and the
       * two tables an analysis needs are a further pair of reads only a starred
       * or batched panel ever makes (`panels/MapPanel.ts`). So on a freshly
       * opened deck the first press found three of four ready, ran three, and
       * left the fourth reading — with nothing on screen saying so, since the
       * result that never came looks exactly like the result of a task that had
       * nothing to say. Pressing again worked, which made it look like the file.
       *
       * Awaited rather than polled, and every panel at once rather than in turn:
       * these are two small reads per file against workers that already exist.
       * A panel that *cannot* answer — a refusal, a file that will not open —
       * settles without facts and is simply not in the list, which is the same
       * answer it gave before and the one its own note already explains.
       */
      allTargetsReady: async () => {
        await Promise.all(
          (this.deck?.analysable() ?? [])
            .filter(({ panel }) => panel.analysisFacts() === null)
            .map(({ panel }) => panel.prepareAnalysis(() => this.analysis?.refresh())),
        )
        if (this.destroyed) return []
        return this.readyTargets({ start: false })
      },
      /**
       * How many maps a batch will *end up* covering, ready or not.
       *
       * What the button counts, and not `allTargets().length`: a deck of four
       * with one still opening offered "run on all 3 maps" and then ran four,
       * which is the button lying about the smaller number rather than the
       * larger. Every map in the grid is going to be run on — {@link
       * allTargetsReady} waits for them — so every map in the grid is counted.
       */
      targetCount: () =>
        (this.file === null ? 0 : 1) + (this.deck?.analysable().length ?? 0),
      annotations: () => this.annotations?.client ?? null,
      // Taken rather than read: the rows belong to the first workspace built
      // after the switch, and a second one — a later navigation, a reload of the
      // chunk — must not be handed the same numbers again under ids the store
      // already holds.
      carried: () => {
        const rows = this.carriedAnalysis ?? []
        this.carriedAnalysis = null
        return rows
      },
      contigs: () =>
        (this.analysisContext()?.contigs ?? []).map((contig) => ({
          name: contig.name,
          startBin: contig.startBin,
          bins: contig.bins,
          length: contig.length,
        })),
      changed: () => {
        this.setAnalysis(this.analysis?.hasTasks === true ? [this.analysis.panelEl] : [])
      },
    }
  }

  /**
   * What the panel prices and the form fills its dropdowns from.
   *
   * Rebuilt per call rather than held, and cheaply: it is a walk over the contig
   * table, and the alternative is a cached object that is wrong every time a
   * track is loaded or the map is panned. `analysis/context.ts` does the work.
   */
  /**
   * The starred companion's facts, or `null` when the star is on the lead.
   *
   * The star (§18.2) says which picture an analysis reads, and it is a second
   * idea from the lead on purpose: the lead is what the *session* is of — the
   * breadcrumb, the tables, the tracks — and it does not move. What a deck is
   * often for is the other question, four replicates on screen and *this* one to
   * measure, and answering that by changing the session's subject would rewrite
   * half the furniture to run a P(s).
   *
   * `null` while a freshly starred panel is still fetching its tables, which the
   * Analysis column reads as "no context" for the frame or two it takes — the
   * honest answer, since the alternative is pricing a task against the lead
   * under a star that says otherwise.
   */
  private starredFacts(): AnalysisFacts | null {
    return this.deck?.starredPanel?.analysisFacts() ?? null
  }

  /**
   * The maps a task can run against, as the runner's targets.
   *
   * One list built two ways, which is the point of the parameter: the
   * synchronous caller wants whatever is ready *and* wants the rest to start
   * reading, and the awaiting one has already waited and must not kick off a
   * second round of the same reads. Both give the lead first, which is the order
   * a reader looking at the grid expects a batch to follow.
   */
  private readyTargets(options: { start: boolean }): RunTarget[] {
    const out: RunTarget[] = []
    const file = this.file
    if (file !== null) {
      out.push({
        map: LEAD_MAP,
        uri: file.uri,
        source: file.source,
        ...cellsOfMap(file.info),
        ...binningOfMap(file.info),
        label: fileLabel(file.uri),
      })
    }
    for (const { map, panel } of this.deck?.analysable() ?? []) {
      const facts = panel.analysisFacts()
      if (facts === null) {
        if (options.start) void panel.prepareAnalysis(() => this.analysis?.refresh())
        continue
      }
      out.push({
        map,
        uri: facts.uri,
        source: facts.source,
        ...cellsOfMap(facts.info),
        ...binningOfMap(facts.info),
        label: fileLabel(facts.uri),
      })
    }
    return out
  }

  private analysisContext(): AnalysisContext | null {
    const file = this.file
    // **A session with no contact map still has a panel.** Three tasks run
    // entirely on loaded tracks — metaplot, track correlation, interval overlap
    // — and a 1D browser session (§5.8) is exactly where a reader has the tracks
    // and not the matrix. Returning `null` here took the whole column away from
    // them, which taught a reader who came in through a bigWig that this app
    // does not compare two of them.
    //
    // The map tasks are not hidden either: they are `waiting`, with a line
    // saying to open a contact map. `hasMap` is what tells them apart, and it
    // stays false here because `nBins` is zero however real the bin size is.
    //
    // The **bin size is not zero**, and it used to be. The zero was safe for as
    // long as the assumption under it held — that nothing producing a per-bin
    // result could be run without a matrix, so no runner would ever see it — and
    // the motif search broke that assumption by answering from the *sequence*,
    // which is present with or without a map. A zero bin size gives every contig
    // zero bins, and a profile registered against that grid is a lane that is
    // permanently empty rather than one that is visibly wrong, which is the
    // failure nothing reports. So a mapless session is given a browsing grid
    // chosen from the assembly's own length ({@link browsingBinsize}); it is a
    // resolution to *draw* at and never a claim that anything was measured at
    // it, which is exactly what `hasMap` remains false to say.
    if (file === null) {
      const assembly = this.assembly
      if (assembly === null) return null
      return buildAnalysisContext({
        uri: assembly.uri,
        layout: 'cool',
        binsize: browsingBinsize(assembly.total),
        nBins: 0,
        hasGenomes: false,
        hasWeights: false,
        scoreColumns: [],
        // The assembly's own sequences, in its own shape, so a region control
        // in a browser session lists what is actually open.
        contigs: {
          length: assembly.contigs.length,
          columns: ['name', 'length'],
          data: {
            name: assembly.contigs.map((contig) => contig.name),
            length: Float64Array.from(assembly.contigs.map((contig) => contig.length)),
          },
        },
        genomes: null,
        displayGenomes: null,
        entries: this.annotations?.store.entries ?? [],
        framing: null,
        blockLoaded: false,
        blockBytes: 0,
      })
    }
    // Every coordinate a *map* analysis produces is arithmetic on a fixed bin
    // grid (§3.3), so a file without one has nothing those tasks can be computed
    // over. A variable-bin file is refused at open long before this, and this is
    // the type being honest about a case the reader has already excluded — the
    // track tasks still apply, so it is a mapless context rather than none.
    // The star, where one has moved: an analysis is priced, framed and run
    // against the picture it points at, and the lead only answers when it is
    // itself the starred map. `entries` stays the session's, because the tracks
    // are the session's however many maps are on screen.
    const starred = this.starredFacts()
    const starredPanel = this.deck?.starredPanel ?? null
    const info = starred?.info ?? file.info
    const uri = starred?.uri ?? file.uri
    const binsize = info.binsize
    if (binsize === null || binsize <= 0) return null
    const panel = starred === null ? this.current?.panel : (starredPanel?.map ?? undefined)
    const framing = panel === undefined || panel === null ? null : panel.analysisFraming(uri)
    const block = panel === undefined || panel === null ? null : panel.analysisBlock()
    return buildAnalysisContext({
      uri,
      layout: info.layout.kind,
      binsize,
      nBins: info.nBins,
      hasGenomes: info.hasGenomes,
      hasWeights: info.hasWeights,
      scoreColumns: info.scoreColumns,
      contigs: starred === null ? (file.contigs?.table ?? null) : starred.contigs.table,
      genomes: starred === null ? file.genomes.table : (starred.genomes?.table ?? null),
      displayGenomes: starred === null ? file.genomes.display : (starred.genomes?.display ?? null),
      entries: this.annotations?.store.entries ?? [],
      framing,
      blockLoaded: block !== null,
      blockBytes: block === null ? 0 : block.values.byteLength,
      // The cells of the map the star is on, not of the session's first file: a
      // deck can hold an `.scool` beside a `.cool`, and the per-cell task is
      // offered for whichever one an analysis would be measured against.
      cells: info.cells.length,
      activeCells: info.activeCells.length,
      // Every map on screen **except the one this context is about**, which is
      // the star. A task that compares two files is offered the others, and a
      // map cannot be a peer of itself.
      peers: (this.deck?.analysable() ?? [])
        .map(({ panel }) => panel.analysisFacts())
        .filter((facts): facts is NonNullable<typeof facts> => facts !== null)
        .filter((facts) => facts.uri !== uri)
        .map((facts) => ({
          label: fileLabel(facts.uri),
          uri: facts.uri,
          binsize: facts.info.binsize ?? 0,
        })),
    })
  }

  private setAnalysis(nodes: readonly HTMLElement[]): void {
    this.analysisHost.replaceChildren(...nodes)
    this.setAvailability('analysis', nodes.length > 0)
  }

  private setGeneral(nodes: readonly HTMLElement[]): void {
    this.generalHost.replaceChildren(...nodes)
    this.setAvailability('general', nodes.length > 0)
  }

  private setAnnotations(nodes: readonly HTMLElement[]): void {
    this.annotationNodes = nodes
    this.renderAnnotations()
  }

  /**
   * The list, with the analysis card put where its marker is.
   *
   * Dropped rather than left empty where there is no workspace yet — a card
   * titled *Synthetic tracks* with nothing in it and nothing on the way is a box
   * the reader has to work out the meaning of, and the workspace arrives a frame
   * or two later on every file.
   */
  private renderAnnotations(): void {
    const out: HTMLElement[] = []
    for (const node of this.annotationNodes) {
      if (node !== this.syntheticSlot) {
        out.push(node)
        continue
      }
      if (this.syntheticCard !== null) out.push(this.syntheticCard)
    }
    this.annotationsHost.replaceChildren(...out)
    this.setAvailability('annotations', out.length > 0)
  }

  private setAesthetics(nodes: readonly HTMLElement[]): void {
    this.aestheticsHost.replaceChildren(...nodes)
    this.setAvailability('aesthetics', nodes.length > 0)
  }

  private setAvailability(
    which: 'general' | 'annotations' | 'aesthetics' | 'analysis',
    on: boolean,
  ): void {
    const field =
      which === 'general'
        ? 'generalOn'
        : which === 'annotations'
          ? 'annotationsOn'
          : which === 'aesthetics'
            ? 'aestheticsOn'
            : 'analysisOn'
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
/**
 * A determinate bar, for the one wait in this app that has a denominator.
 *
 * Everything else the reader waits for is a bounded read whose cost is a
 * handful of range requests, and `loading` — a spinner and a sentence — is the
 * honest picture of one. A `.pairs` import is the exception: it walks the whole
 * file, it can be minutes on a large one, and there is no map behind it to look
 * at meanwhile. A spinner over that is the difference between "working" and
 * "hung".
 *
 * Returned with its own `update`, so the caller drives it from the worker's
 * progress messages without this module knowing anything about them.
 */
export function progressView(message: string): {
  el: HTMLElement
  update(done: number, total: number, note?: string): void
} {
  const fill = el('div', { class: 'pairs-progress-fill' })
  const note = el('p', { class: 'pairs-progress-note', text: 'Starting…' })
  const bar = el(
    'div',
    {
      class: 'pairs-progress-bar',
      attrs: { role: 'progressbar', 'aria-label': message, 'aria-valuemin': '0', 'aria-valuemax': '100' },
    },
    fill,
  )
  const root = el(
    'div',
    { class: 'pairs-progress' },
    el('p', { class: 'loading-text', text: `${message}…` }),
    bar,
    note,
  )
  return {
    el: root,
    update(done: number, total: number, text?: string): void {
      const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0
      fill.style.width = `${(fraction * 100).toFixed(1)}%`
      bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)))
      note.textContent = text === undefined ? `${Math.round(fraction * 100)}%` : `${text} — ${Math.round(fraction * 100)}%`
    },
  }
}

/**
 * Say what the file did not contain, when it did not contain everything.
 *
 * A map binned from a truncated `.pairs` is not blank and not wrong — every
 * number in it is true of the records that arrived — so nothing on screen
 * distinguishes *this library has no contacts on chromosome XIII* from *this
 * file stops before chromosome XIII*. That is the whole reason this exists: the
 * reader cannot work it out from the picture, and being quiet leaves them to
 * conclude the first when it is the second.
 *
 * A note rather than a refusal, and it stays until it is dismissed. The data
 * that is there is real and worth looking at; what is not on is drawing it
 * without saying so.
 */
function reportImportGaps(summary: PairsImportSummary): void {
  const missing = summary.sequencesWithoutCisContacts
  if (!summary.truncated && missing.length === 0) return

  const named = missing.length > 6 ? `${missing.slice(0, 6).join(', ')} and ${missing.length - 6} more` : missing.join(', ')
  const parts: string[] = []
  if (summary.truncated) {
    parts.push(
      'This .pairs file is incomplete: it ends part-way through a compressed block, with no ' +
        'end-of-file marker. Whatever was written is binned and drawn, but the rest of the file ' +
        'was never there to read.',
    )
  }
  if (missing.length > 0) {
    parts.push(
      `${missing.length} ${missing.length === 1 ? 'sequence has' : 'sequences have'} nothing on ` +
        `${missing.length === 1 ? 'its' : 'their'} own diagonal: ${named}.`,
    )
  }
  if (summary.truncated && missing.length > 0) {
    parts.push('Those two together usually mean the file was cut off before those sequences.')
  }

  const note = progressToast(summary.truncated ? 'Incomplete file' : 'Empty sequences')
  note.fail(parts.join(' '))
}

/**
 * The probe carried by a `pairs-binning-needed` refusal, or `null`.
 *
 * The counterpart to `firstEntry`: both read a typed refusal and turn it into
 * the next step, rather than into an error screen. Written as a guard rather
 * than a cast because the detail crosses a worker boundary and arrives as plain
 * data — a missing field here is a protocol change, and it should show up as a
 * dialog that does not open rather than as `undefined` in an input box.
 */
export function pairsProbe(err: unknown): PairsProbeResult | null {
  if (!(err instanceof ViewerError) || err.code !== 'pairs-binning-needed') return null
  const detail = err.detail as Partial<PairsProbeResult>
  if (!Array.isArray(detail.contigs) || detail.contigs.length === 0) return null
  if (typeof detail.suggestedBase !== 'number' || detail.suggestedBase < 1) return null
  return {
    contigs: detail.contigs,
    genomeLength: detail.genomeLength ?? 0,
    records: detail.records ?? null,
    indexed: detail.indexed === true,
    assembly: detail.assembly ?? null,
    sorted: detail.sorted ?? null,
    sourceBytes: detail.sourceBytes ?? 0,
    suggestedBase: detail.suggestedBase,
  }
}

export function loading(message: string): HTMLElement {
  return el(
    'div',
    { class: 'loading' },
    el('div', { class: 'spinner', attrs: { role: 'progressbar', 'aria-label': message } }),
    el('p', { class: 'loading-text', text: `${message}…` }),
  )
}

/**
 * The loading screen an open can talk back to.
 *
 * A spinner says *something is happening* and is the right answer for an open
 * that takes a moment. It is the wrong answer for one that takes a minute — a
 * HiC-Pro matrix read whole (§3.9), or an `.scool` downloaded whole (§3.8) —
 * where a reader watching it has no way to tell a slow connection from a hung
 * one, and no way out.
 *
 * So the spinner stays until the worker says otherwise, and the first progress
 * report replaces it with a bar, a line of prose and a way to stop. The bar is
 * per *phase* rather than across the whole open: downloading is measured in
 * bytes and parsing in pixels, and one bar sliding between two denominators
 * would look like it had gone backwards. Two labelled sweeps is what a reader
 * can actually follow.
 */
export class LoadingView {
  readonly el: HTMLElement
  private readonly text: HTMLElement
  private readonly bar: HTMLProgressElement
  private readonly box: HTMLElement

  constructor(message: string, onCancel?: () => void) {
    this.text = el('p', { class: 'loading-text', text: `${message}…` })
    this.bar = el('progress', { class: 'progress' }) as HTMLProgressElement
    this.bar.max = 1
    this.bar.value = 0
    const stop =
      onCancel === undefined
        ? null
        : button('cancel', () => onCancel(), { class: 'btn btn-quiet' })
    this.box = el(
      'div',
      { class: 'progress-box hidden' },
      this.bar,
      ...(stop === null ? [] : [stop]),
    )
    this.el = el(
      'div',
      { class: 'loading' },
      el('div', { class: 'spinner', attrs: { role: 'progressbar', 'aria-label': message } }),
      this.text,
      this.box,
    )
  }

  /**
   * Show what the worker is doing now.
   *
   * A `total` of zero is *indeterminate* rather than *finished* — a host that
   * states no `Content-Length` gives one — so the bar loses its value and the
   * browser draws it as the barber's pole it has for exactly this.
   */
  report(done: number, total: number, note?: string): void {
    this.box.classList.remove('hidden')
    const phase = note ?? 'reading'
    if (total > 0) {
      this.bar.value = Math.min(1, done / total)
      this.text.textContent = `${phase} — ${describe(done, total, note)}`
    } else {
      this.bar.removeAttribute('value')
      // Nothing counted *and* nothing to count it against is a phase that has
      // only a name — the cell listing is one, and `0 B` beside it would read
      // as a stalled download rather than as a wait with no meter on it.
      this.text.textContent = done > 0 ? `${phase} — ${fmt.bytes(done)}` : `${phase}…`
    }
  }
}

/**
 * The two halves of an open, each in the units it is actually counted in.
 *
 * Bytes look like bytes and pixels look like counts; saying "14,769,558 of
 * 14,769,558" in megabytes, or a download in pixels, is the kind of small lie
 * that makes a reader distrust the whole bar.
 */
function describe(done: number, total: number, note?: string): string {
  const counted = note?.includes('pixel') === true || note?.includes('cell') === true
  return counted
    ? `${fmt.int(done)} of ${fmt.int(total)}`
    : `${fmt.bytes(done)} of ${fmt.bytes(total)}`
}

/**
 * The cell set of a map, for the analysis worker's own mount of it.
 *
 * Spread rather than returned, so a file with no cells contributes no key at
 * all: `cells: undefined` on the request would be a field the protocol has to
 * mean something by, and *absent* already means the only thing it could —
 * every cell, which is what an scool with nothing ticked draws.
 */
function cellsOfMap(info: OpenResult): { cells?: readonly string[] } {
  return info.cells.length === 0 ? {} : { cells: info.activeCells }
}

/**
 * How this map was binned, where it was imported from a `.pairs` (§3.7).
 *
 * The second half of what a second mount needs, beside the cells. A contact list
 * has no resolution of its own, so the analysis worker opening the same file is
 * refused with the question the reader already answered in a dialog before the
 * map existed — and every §18 task on an imported map failed there. The answer
 * travels with the target instead.
 */
function binningOfMap(info: OpenResult): {
  binning?: PairsBinning
  orientation?: OrientationSummary
} {
  if (info.pairs === undefined) return {}
  return {
    binning: info.pairs.binning,
    ...(info.pairs.orientation === null ? {} : { orientation: info.pairs.orientation }),
  }
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
/**
 * Two name lists holding the same names in the same order.
 *
 * Order counts because the worker resolves a set into file order, and a list
 * that matches it element for element is one that needs no swap. Two sets with
 * the same members in a different order compare unequal here and cost one
 * redundant swap, which is cheaper than sorting four thousand names to find out.
 */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Attach the bin file this session already holds for a HiC-Pro matrix.
 *
 * Two of §3.9's three roads in, and both are things only the *shell* knows: a
 * file dropped alongside the matrix, or picked out of a connected folder beside
 * it, arrives as `index` exactly as a `.bai` does; and a URL may name its bin
 * file in a `#bins=` fragment, which is the escape hatch for a bucket the
 * convention cannot guess at.
 *
 * The third road — probing the conventional name — is deliberately *not* here.
 * It costs a request, the worker is where requests are made and counted, and
 * putting it here would mean two places that know where HiC-Pro writes its bin
 * files.
 *
 * Exported for the test: the signing below is invisible from anywhere the
 * session can be driven — the credential is on a message this function's caller
 * hands to a worker — and it is the half of a private pair that was silently
 * being read unsigned.
 */
export function withHicProBins(uri: string, source: SourceSpec, index?: File): SourceSpec {
  const { address, bins: named } = splitBinsFragment(uri)
  if (!isHicProMatrix(splitUri(address).path)) return source
  if (index !== undefined) return { ...source, bins: { kind: 'local', file: index } }
  if (named === undefined) return source
  // The named half goes through the rewrite table on its own (SPECS §24.5): it
  // is a URL somebody typed after a `#bins=`, and nothing else canonicalises it
  // — `canonicalUrl` treats a fragment as opaque text, which is what makes it
  // safe to carry one across a rewrite of the other half and is why the inner
  // URL has to be asked separately.
  const bins = canonicalUrl(named)
  // The fragment is stripped from the *source*, not from the URI. A `#` is
  // never sent to a server, so the fetch would have worked either way — but the
  // name is read off this URL to decide the file is a matrix at all, and
  // `orphan.matrix#bins=…` does not end in `.matrix`. The URI keeps its
  // fragment, because that is what makes the pair one shareable string (§11).
  const at: SourceSpec =
    source.kind === 'remote' ? { ...source, url: splitUri(address).path } : source
  // Signed here, against the bin file's **own** URL.
  //
  // Everywhere else a credential is stamped at the worker boundary
  // (`s3/attach.ts`), and that stamper knows only `message.source` — it has
  // never looked at the second half hanging off it. So a pair under a private
  // prefix went out with a signed matrix and an unsigned bin file, and S3
  // answered 403 to the half that carries the coordinates: the open failed on
  // exactly the arrangement `#bins=` exists for. The conventional road does not
  // have this hole — `probeBins` passes the matrix's credential to the bed it
  // guesses (`worker/open.ts`) — so the guessed bin file worked and the named
  // one did not.
  //
  // Its own URL rather than the matrix's, because `#bins=` is the escape hatch
  // for a bucket that publishes the two halves under unrelated keys: the bed
  // may sit outside every scope the matrix is in, and a public request that
  // gets signed anyway is the failure this repo guards hardest against
  // (`s3/credentials.ts`). Unscoped stays unsigned, as it was.
  const credential = credentialFor(bins)
  return {
    ...at,
    bins:
      credential === null
        ? { kind: 'remote', url: bins }
        : { kind: 'remote', url: bins, credential },
  }
}

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
 * Name and length per chromosome, in file order — what the compare gate reads.
 *
 * Both, because both have to match: a renamed assembly and a re-scaffolded one
 * are different failures and the gate names each of them (`ui/CompareCard.ts`).
 */
/**
 * The same view with the second file **said to be gone**.
 *
 * Present and `undefined`, which is not the same thing as absent here and is
 * the whole of why this is a function rather than a destructuring at the call
 * site. {@link Session.withCompanions} carries `uri2` forward across a
 * navigation *unless the caller has said something about it*, and the test it
 * uses is `key in next` — so a state that merely omits the key is a state that
 * has said nothing, and the previous rung's second file is put straight back
 * into it. The hash is written from the keys whose value is defined
 * (`serialiseViewState`), so this serialises exactly as an absent key does.
 */
export function withoutSecond(state: ViewState): ViewState {
  return { ...state, uri2: undefined }
}

/**
 * Where a carried comparison is addressed at `binsize`, or `null` for a file
 * that has no rung there.
 *
 * `null` is not a failure to look it up: it is the answer that the two files
 * cannot be compared at this resolution, which is the gate's own rule seen from
 * the other side. **Exact**, on {@link Session.openAtBinsize}'s rule and for its
 * reason — the nearest rung is a different picture, and drawing it under a
 * label that says the reader's own resolution would be a lie the picture cannot
 * betray.
 *
 * Exported for the test: it is the one piece of arithmetic in the carry, and
 * everything around it needs a worker and two open files to reach.
 */
export function compareRung(carried: CompareCarry, binsize: number | null): string | null {
  if (binsize === null || !(binsize > 0)) return null
  if (carried.binsize === binsize) return carried.uri
  const match = rungsOf(carried.entries).find((rung) => rung.binsize === binsize)
  if (match === undefined) return null
  return `${splitUri(carried.uri).path}::${carried.entryGroup || 'entries'}/${match.name}`
}

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
/**
 * The genome each sequence belongs to, by name (§8.5).
 *
 * Built from the two tables the session already holds: `/contigs`' `genome_id`
 * is an index into `/genomes`, which is not something an annotation file — or
 * the reader of a warning about one — can look up. Empty for a cooler, which
 * has neither column.
 */
function contigGenomes(
  contigs: ContigsResult | null,
  genomes: TablePayload | null,
): Map<string, string> {
  const out = new Map<string, string>()
  const names = contigNames(contigs)
  const ids = contigs?.table.data['genome_id']
  const genomeNames = genomes?.data['name']
  if (ids === undefined || Array.isArray(ids) || !Array.isArray(genomeNames)) return out
  for (let i = 0; i < names.length && i < ids.length; i++) {
    const genome = (genomeNames as string[])[Number(ids[i])]
    // `__unbinned__` is not a genome (§7.4): it is every contig binning failed
    // to place, it is excluded from every view and every count in this app, and
    // counting it here would put a 49th organism in a sentence about 48 — and
    // name it as one a track "covers" when what the track covers is the
    // leftovers.
    if (genome !== undefined && genome !== UNBINNED_NAME) out.set(names[i], genome)
  }
  return out
}

function contigLengths(contigs: ContigsResult | null): Map<string, number> {
  const out = new Map<string, number>()
  const names = contigNames(contigs)
  const lengths = contigs?.table.data['length']
  if (names.length === 0 || lengths === undefined || Array.isArray(lengths)) return out
  for (let i = 0; i < names.length; i++) out.set(names[i], Number(lengths[i]))
  return out
}
