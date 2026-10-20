/**
 * One session: a file, the views of it, and everything that outlives a
 * navigation inside it.
 *
 * This is the object the app used to *be*. It held the reader client (which owns
 * the worker, which owns all I/O), the view store (which owned the URL hash),
 * the two tables read once at open, and the annotation stores — and it swapped
 * the view underneath them. All of that is still here, unchanged in substance;
 * what left is the window furniture, which is now {@link App}'s, because a
 * header, five columns and one address bar are shared by every session and a
 * file is not.
 *
 * The split is what makes tabs possible, and it is the whole of what makes them
 * possible: two sessions are two of these, each with its own worker, its own
 * stores and its own DOM, and the shell shows one of them at a time. Nothing
 * here is a singleton and nothing here reads `window.location` — a session that
 * did either would work perfectly until the second tab was opened.
 *
 * Five of its sections are classes of their own, each holding what only it
 * reads: the second file (`SessionCompare`), the deck of panels (`SessionDeck`),
 * the analysis bridge (`SessionAnalysis`), the command list (`SessionCommands`)
 * and routing (`SessionRouter`) — a switch over `ViewState.view`, with no route
 * table and no router library, because the whole navigable surface is ten view
 * kinds and one URL hash (spec §5.5). The session keeps the state they all read
 * and its lifecycle — the constructor, `activate`, `destroy` — and stays the one
 * door the shell and the tests come through. What a collaborator reaches on it
 * is marked `@internal`, with the reason: TypeScript has no friend classes, so
 * those members are public in the type and the session's own by convention.
 */

import { AnnotationLoader, leadOf, pairIndexes } from '../annotations/loader'
import { begin } from '../perf/rendered'
import { devFeature } from '../state/devFeatures'
import { EDIT_SCOPE, EditStore, genomeEditKey, readEdit } from '../state/referenceEdit'
import { EditedAssembly, editFingerprint, type ReferenceEdit } from '../genome/edit'
import { carryRegion, windowInFile } from '../edit/places'
import { EditStage } from '../edit/EditStage'
import { pickGenome, type PickableGenome } from '../edit/GenomePicker'
import { UNBINNED, binningTable, type BinningTable } from '../edit/binning'
import { ReferenceChip } from '../edit/ReferenceChip'
import { DEFAULT_UI_COLORMAP } from '../render/colormaps'
import { ManualStore, type ManualMark } from '../annotations/manual'
import { GroupSettings } from '../annotations/groups'
import { AnnotationStore } from '../annotations/store'
import { AnnotationClient } from '../annotations/worker/client'
import { AnalysisClient } from '../analysis/worker/client'
import type { CorrelationField } from '../analysis/compartments'
import type { AnalysisFraming, TableOutput } from '../analysis/types'
import type { CarriedResult } from '../analysis/workspace'
import { UNBINNED_NAME } from '../constants'
import { CircularStore } from '../state/circular'
import { OriginStore } from '../state/origins'
import {
  junctionCandidates,
  junctionRung,
  measureJunctions,
  placeCandidate,
  type JunctionCandidate,
  type JunctionReader,
} from '../analysis/circularity'
import { ResolutionStore } from '../state/resolutions'
import { CoarseGrid, ladderWith, offsetsOf, type DerivedGrid, type DerivedRung, type Rung } from '../metacooler/coarsen'
import { openResolutionDialog } from '../ui/ResolutionDialog'
import { ViewerError } from '../errors'
import {
  COMPANION_KEYS,
  READING_KEYS,
  SUBJECT_KEYS,
  ViewStore,
  cellsOf,
  cellsPatch,
  landingState,
  matrixLevel,
  overviewLevel,
  selectionOf,
  metaScopeOf,
  metaShown,
  sequencesShown,
  viewForMeta,
  viewForSequences,
  viewStateEquals,
  type MetaScope,
  type UnitSelection,
} from '../state/ViewState'
import { parseRegionString } from '../metacooler/range'
import { fileMemoryKey, recall, remember } from '../state/UiMemory'
import { getPlotOptions, setPlotOptions } from '../ui/plotOptions'
import type { PanelLayout } from '../ui/SidePanel'
import { afterHome, homeParent, hostHolds, removeCard, swapCard } from '../ui/cardLayout'
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
import type { Transform, ViewKind, ViewState } from '../types'
import type { Normalisation, SmoothedField, SmoothingRequest } from '../render/derive'
import { parseSmooth } from '../render/smooth'
import type { RotateDirection } from '../render/rotate'
import { LEAD_MAP, type Lane } from '../annotations/placement'
import type {
  ArmsPresentation,
  CircularPresentation,
  DerivePresentation,
  TurnPresentation,
} from '../ui/MatrixPanel'
import type { CirclePresentation, LinesPresentation } from '../ui/CircleView'
import { lineSplit, splitChoices, type SplitChoice } from './lineSplit'
import { slotCount, type CircleResolver, type CircleUnit } from '../render/circle'
import type { AxisGenomes } from '../render/blockOrder'
import {
  FILE_ORDER,
  OrderStore,
  arrange,
  isFileOrder,
  withContigsMoved,
  withGenomesMoved,
  type ReaderOrder,
  type Side,
} from '../state/readerOrder'
import { circleResolverFrom } from './circleIndex'
import { binsForLength } from '../analysis/context'
import { isCancellation, ReaderClient, type Cancellable } from '../worker/client'
import type {
  CellsResult,
  ContigsResult,
  GenomesResult,
  McoolExport,
  OpenResult,
  PairsBinning,
  PairsImportSummary,
  PairsProbeResult,
  ResampleResult,
  SourceSpec,
  TablePayload,
} from '../worker/protocol'
import type { WireSource } from '../annotations/worker/protocol'
import type { PickedFile } from '../browse/folder'
import { isTextTableName, routeFor, routeOf, type FileRoute } from '../browse/route'
import { driveFileName } from '../browse/driveName'
import { connectDirectory, subscribeFolders } from '../browse/connected'
import { adoptFolders, hasLocation, missingFolderOf } from '../state/locations'
import type { AssemblyResult } from '../annotations/worker/protocol'
import { isHicProMatrix, splitBinsFragment, splitIndexFragment } from '../annotations/sidecar'
import { readFileDrag } from '../ui/fileDrag'
import {
  assemblyOf,
  findContig,
  formatLocus,
  lengthsAreExact,
  parseLocus,
  replacesLengths,
  type Assembly,
  type AssemblyOrigin,
  type Contig,
} from '../genome/assembly'
import { SequenceSelection } from '../genome/selection'
import { placementOn, type AnnotationEntry, type Placement } from '../annotations/types'
import { AnnotationCard } from '../ui/AnnotationCard'
import { StructureCard } from '../ui/StructureCard'
import { Breadcrumb, rungStandingAt } from '../ui/Breadcrumb'
import { resolutionLabel } from '../units'
import { ContactsBox, type MapTotal } from '../ui/ContactsBox'
import type { DrawnDepth } from '../contacts'
import type { Census } from '../metacooler/resample'
import type { ResampleTarget } from '../analysis/worker/protocol'
import { BrowserView } from '../ui/BrowserView'
import { CompareCard, LEAD_ROW } from '../ui/CompareCard'
import { ManualCard, type MapPicker } from '../ui/ManualCard'
import { chooseSaveTarget, downloadBlob, exportBaseName, fileStamp } from '../ui/export'
import { mcoolNameFor } from '../pairs/mcoolName'
import { MetadataCard } from '../ui/MetadataCard'
import { metadataIndexFrom, type MetadataIndex } from '../annotations/metaIndex'
import { summaryOf, type MetaLevel } from '../annotations/metadata'
import { BookmarkStore, formatRegion, type Bookmark } from '../annotations/bookmarks'
import { BookmarksCard } from '../ui/BookmarksCard'
import type { AnnotationContext, BorrowedScale, FigureSubject, MatrixPanel, PanelOrder } from '../ui/MatrixPanel'
import { ContigsTable, type CircularColumn, type OriginColumn } from '../ui/ContigsTable'
import { ErrorView } from '../ui/ErrorView'
import { FilePicker, firstEntry } from '../ui/FilePicker'
import type { ProviderId } from '../ui/connectFronts'
import { embedded } from '../embed'
import { openPairsDialog } from '../ui/PairsDialog'
import { progressToast } from '../ui/toast'
import { askLoadCost, isLoadGate } from '../ui/LoadGate'
import { GenomeView, type PanelSeed, type ScaleState } from '../ui/GenomeView'
import { CellsTable, type MeasuredCells } from '../ui/CellsTable'
import { GenomesTable } from '../ui/GenomesTable'
import { InfoPanel } from '../ui/InfoPanel'
import { MinimapCard, suitsMinimap, type MinimapRange } from '../ui/MinimapCard'
import { Overview, WHOLE_FILE_LEVELS } from '../ui/Overview'
import { PairView } from '../ui/PairView'
import { findRow, recordFields, type RecordField, type RecordSpec } from '../ui/RecordCard'
import { RegionView } from '../ui/RegionView'
import {
  BROWSER_TICKS,
  CONTIG_TICKS,
  GENOME_TICKS,
  MAP_TICKS,
  sequenceCard,
  type SequenceCardProps,
  type SequenceRow,
} from '../ui/SequenceCard'
import { WholeView } from '../ui/WholeView'
import type { TableUiState } from '../ui/VirtualTable'
import { KEYS, withKey, type Command } from '../ui/commands'
import { button, el, fmt } from '../ui/dom'
import { cardTitle, iconButton } from '../ui/icons'
import { demoAnnotationsToOffer, shelfWasAsked } from '../ui/examples'
import { contigOf, fileBaseLabel, fileLabel, neighbour, sourceNote, splitUri } from '../ui/labels'
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
import { contigNames, contigPairs } from './contigTable'
import { inferSource, mayResolve, resolveSource } from './resolve'
import { SessionAnalysis } from './SessionAnalysis'
import { SessionCommands } from './SessionCommands'
import { SessionCompare, withoutSecond } from './SessionCompare'
import { SessionDeck } from './SessionDeck'
import { SessionRouter } from './SessionRouter'
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
  /** Open the Connect dialog on this place — a button on the landing page was pressed. */
  openConnect(provider: ProviderId): void
  /** A folder was connected — from the landing page's picker, or from the dialog. Show it. */
  folderConnected(id: string): void
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
  /**
   * Say something quiet and dismissible about what just happened.
   *
   * A session names itself as `owner`: what it says is about the file it has
   * open, so it is shown while this tab is the one in front, and stays only
   * until the session withdraws it ({@link withdrawNotice}, §5.6).
   */
  notify(message: string, owner?: Session): void
  /** Take down what `owner` said, if it is still up: its file is no longer open. */
  withdrawNotice(owner: Session): void
  /** A read finished; the status bar's counters are worth another look. */
  activity(session: Session): void
  /**
   * A file the reader chose or dropped on the landing page has opened.
   *
   * The Files column is the one column that page shows, and it has done its
   * job: the shell folds it for this window, without writing the preference
   * (`ui/SidePanel.ts`, `conceal`), so the plot gets the room.
   */
  landingFileOpened(session: Session): void
  /**
   * The landing page's tutorial button was pressed: play the guided tutorial
   * (§30) from its start or from where the reader left it.
   *
   * Optional, and absent where it cannot be played — a shell with no store
   * drawer for its first step, and a host in a test — so the landing page
   * offers it only where this is here.
   */
  startTutorial?(from: 'start' | 'resume'): void
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
  /** Which sequences are declared circular, for the mark beside each (§8.15). */
  circular?: { has(name: string): boolean; subscribe(listener: () => void): () => void },
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
      // The way out, and only that. The sentence before it — "this file
      // carries no sequence lengths, so each one ends at its last feature
      // rounded up" — is what the `lengths` row above already says, and the
      // row, this hint and the browser's own summary line said it three times
      // on one screen, over a `total` already qualified "(at least)". §5.8 asks
      // for inferred lengths to be *labelled* wherever the genome is described;
      // the label is the row, and what a reader cannot work out for themselves
      // is how to replace them.
      ...(exact
        ? []
        : [
            el('p', {
              class: 'hint',
              text: 'Drop a chrom.sizes or a bigWig to replace them with the real ones.',
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
      ...(circular === undefined ? {} : { circular }),
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

/**
 * How each kind of source is described in the Genome card.
 *
 * **Short enough to fit the card's value column**, which is what these had
 * stopped being: "inferred from the features" and "declared by the VCF's
 * ##contig lines" ran past the card's edge and the reader saw `inferred from
 * the feat` — a phrase cut mid-word, which reads as a typo rather than as
 * something scrolled out of view. The card does not elide a value (see `.kv` in
 * the stylesheet: an identity you cannot read whole is not an identity), so the
 * answer is prose that fits: the *file kind* that answered, and for the
 * inferred case the one word that qualifies it.
 */
const ORIGINS: Record<Assembly['origin'], string> = {
  sizes: 'chrom.sizes',
  bigwig: 'bigWig header',
  bigbed: 'bigBed header',
  fasta: 'the sequences',
  features: 'inferred (rounded up)',
  cooler: 'the cooler’s /chroms',
  bam: 'the BAM’s @SQ header',
  vcf: 'the VCF’s ##contig lines',
  twobit: 'the .2bit index',
  cytoband: 'the cytoBand’s bands',
}

/** What a reader was last told to draw its map to, and what it answered (§6.5). */
interface DrawnState {
  contacts: number | null
  result: ResampleResult | null
  refusal: string | null
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
  /** The structure cell's card as {@link refreshAesthetics} last placed it, so it can be taken out again. */
  private placedStructureCard: HTMLElement | null = null
  /**
   * The starred companion's *Map* card as {@link refreshAesthetics} last put it
   * in the first map's place (§16.5), with the first map's card it stood in
   * for, so the two can be swapped back when the star moves on.
   */
  private placedMapCard: { card: HTMLElement; lead: HTMLElement } | null = null
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
  readonly store = new ViewStore()

  /**
   * The reader worker, built on first use.
   *
   * Lazily, because a restored tab that nobody has clicked yet should cost no
   * worker and no h5wasm instance — that is the whole of what makes restoring
   * eight tabs cheaper than opening eight files.
   *
   * @internal SessionAnalysis runs a task on the first map as its reader draws
   * it, and SessionCommands offers the edit only once there is one.
   */
  reader: ReaderClient | null = null
  /** @internal SessionRouter shows it when the tab holds nothing. */
  readonly picker: FilePicker

  /** @internal The open file: the collaborators ask after it as the session's own sections do. */
  file: OpenFile | null = null
  /**
   * @internal SessionRouter renders the trail on every navigation, and lets it
   * go with the file.
   */
  breadcrumb: Breadcrumb | null = null
  /**
   * The *contacts* box at the end of the breadcrumb (§6.5), built with the bar
   * it sits in and re-seated by it on every render rather than rebuilt.
   *
   * @internal SessionDeck re-reads the box when a companion draws.
   */
  contactsBox: ContactsBox | null = null
  /**
   * What each reader this session holds was last told to draw its map to, and
   * what it answered (§6.5). By client: the lead's worker outlives the files it
   * opens — and each open puts its map back as stored — while the second
   * file's is replaced with the file.
   */
  private readonly drawn = new WeakMap<ReaderClient, DrawnState>()
  /**
   * The census each reader's map was counted by, kept across totals: it does
   * not depend on the total, and a task handed it need not walk the map again.
   */
  private readonly censuses = new WeakMap<ReaderClient, Census>()
  /** Contacts a reader counted for a file that does not say how many it holds. */
  private readonly counted = new WeakMap<ReaderClient, number>()
  /**
   * Which of a reader's opens an answer about its map belongs to. The lead's
   * worker outlives the files it opens, so a census or a count can land after
   * the next file has opened, and it is not a fact about that one.
   */
  private readonly opens = new WeakMap<ReaderClient, number>()
  /** @internal SessionCompare names the second file on it, and SessionRouter fills its records. */
  infoPanel: InfoPanel | null = null
  /**
   * The genome strip, where this session's genome is one worth drawing.
   *
   * Held rather than rebuilt, because it is told where the view moved to on
   * every navigation and every pan ({@link syncMinimap}) — a card reassembled
   * from a function that takes no location could only show the place the column
   * was last built at. One at a time: a session is of one genome, and the map
   * column and the browser column never both hold one.
   *
   * @internal SessionRouter lets it go with the file.
   */
  minimap: MinimapCard | null = null
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
   *
   * @internal SessionRouter lets it go with the file.
   */
  wholeFile: { key: string; view: WholeFileView } | null = null
  /** The tables a circle's sections are sized and filled from, indexed once (§7.6). */
  private circleIndex: {
    genomes: GenomesResult
    contigs: ContigsResult | null
    resolver: CircleResolver
  } | null = null
  /** Whether a circle has already asked for the contigs table. */
  private circleContigsPending = false
  /** @internal SessionRouter waits out an open in flight rather than start a second. */
  opening: string | null = null
  /**
   * @internal The mounted view: SessionDeck leads the deck with its panel,
   * SessionAnalysis frames a task by it, SessionCommands acts on it, and
   * SessionRouter repaints it.
   */
  current: {
    destroy?(): void
    applyScale?(scale: ScaleState): void
    /** The view's own controls, for the Aesthetics column. */
    sideEl?: HTMLElement
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
   *
   * @internal Read by SessionDeck, SessionAnalysis and SessionCommands;
   * SessionRouter lets it go with the file.
   */
  annotations: FileAnnotations | null = null
  /** @internal SessionRouter lets it go with the file. */
  manualCard: ManualCard | null = null
  /**
   * The Metadata card (§8.12); rebuilt with the file, like every other card.
   *
   * @internal SessionRouter lets it go with the file.
   */
  metadataCard: MetadataCard | null = null
  /** @internal SessionCommands saves the view on it, and SessionRouter lets it go with the file. */
  bookmarksCard: BookmarksCard | null = null
  /**
   * The bookmarks behind the card, for the structure cell to name on the model
   * (§25.5).
   *
   * @internal SessionDeck hands it to the structure cell.
   */
  bookmarkStore: BookmarkStore | null = null
  /**
   * The state the mounted view was built for.
   *
   * Kept so `render` can tell a navigation from a repaint. `this.current` is the
   * view object; this is what it was built from.
   *
   * @internal SessionRouter writes it on every mount, the doors that put a view
   * down clear it, and the DOM tests read it.
   */
  mounted: ViewState | null = null
  /**
   * The scale a derivation on the outgoing map had taken over, for the map
   * {@link remount} builds in its place (§7.5).
   *
   * Not in the hash, which holds what the derivation drew with: a ratio's
   * `log2` and diverging ramp. A change of comparison is a rebuild, and the
   * panel that would have given the scale back is the one torn down — so the
   * split after a ratio was drawn on the ratio's scale. Spent by the next view
   * built for the same file.
   */
  private carriedScale: { uri: string; restore: BorrowedScale } | null = null
  /**
   * The render in progress, as something the next one calls off (§5.5).
   *
   * Every change to the store starts a `render` that nobody awaits, and a render
   * awaits — the source, the open, the deck, the cells, the contigs table — so
   * two of them interleave whenever the reader is quicker than the file. Each
   * render aborts this one and installs its own, and every step after an await
   * asks {@link stale} whether it is still the newest before it touches the
   * view. The store comparison alone missed the case that matters most: a
   * second render of the *same* state object, which four callers start, ran to
   * the end beside the first and mounted the view twice.
   *
   * @internal SessionRouter installs a fresh one for every render; the mounts
   * here take its signal on entry, and the DOM tests read it.
   */
  rendering = new AbortController()
  /** Memoised {@link stepTargets}, keyed on the state object's identity. */
  private stepCache: { state: ViewState; previous: string | null; next: string | null } | null = null
  /** The reader's order of the open file's genomes and contigs (§7.6), and the file it is kept for. */
  private orderHeld: { key: string; store: OrderStore; off: () => void } | null = null
  /** Every contig in the reader's order, kept until the table or the order moves. */
  private arrangedContigsMemo: { names: string[]; order: ReaderOrder; out: number[] } | null = null
  /** The Genomes table's columns as the two lines' `split by` offers them (§7.6), kept per table. */
  private splitChoicesMemo: { genomes: GenomesResult; choices: readonly SplitChoice[] } | null = null
  /**
   * The second file in the lower-left triangle, and everything it takes to
   * hold one: its reader, its gate, its eye, and its carry across a change of
   * resolution (`SessionCompare`).
   *
   * @internal SessionDeck opens the second file in a cell and lists it, and
   * SessionRouter reconciles it with every state.
   */
  readonly compare = new SessionCompare(this)
  /**
   * The Contact maps card: every map this session holds, the second file's row
   * among them.
   *
   * @internal The session builds it and replaces it with the file;
   * SessionCompare writes the second file's state on it, and SessionRouter lets
   * it go.
   */
  compareCard: CompareCard | null = null
  /**
   * The deck of panels (§16): further files beside this one, the `+` edges
   * round a map that has none yet, and the maps the eye took out of it
   * (`SessionDeck`). `grid` is the deck itself, or `null` while there is none.
   *
   * @internal SessionAnalysis runs a task on the starred map and lists the
   * others, SessionCommands lists the cells' keys and copies the deck, and
   * SessionRouter puts it down with the file.
   */
  readonly deck = new SessionDeck(this)
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
   *
   * @internal The genome a 1D session is of: SessionDeck, SessionAnalysis and
   * SessionCommands read it, and SessionRouter routes the browser by it.
   */
  assembly: Assembly | null = null
  /** Structure rows already seen, so a new one opens its cell (§25.3); `null` until the watch begins. */
  /**
   * The structure rows seen so far, by id, with the payload each held — so a
   * row that is *replaced* under its id (a reconstruction run again lands on
   * the same row, §25.6) reads as a fresh model too, and the cell draws it.
   *
   * @internal SessionRouter lets it go with the file.
   */
  knownStructures: Map<string, unknown> | null = null
  /**
   * The file that opened this browser was a **structure** alone, and its model
   * is still to be put on screen — once the browser is mounted, which is the
   * first moment a deck can frame it ({@link showStructureAlone}).
   */
  private structureAlone = false
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
   *
   * @internal SessionAnalysis names it as the file a mapless task measured, and
   * SessionRouter lets it go with the file.
   */
  assemblySource: SourceSpec | null = null
  /**
   * Where the map goes back to while the browser is on screen.
   *
   * Non-null is the whole of "there is a map behind this": {@link file} and the
   * reader are untouched, and this is the view state to return to. The eye
   * beside the file's name in the Contact maps card is what sets and clears it,
   * which is the same control a track's own row carries — a map is a thing laid
   * over this genome too, and the largest of them.
   *
   * @internal SessionRouter brings the map back when a state asks for it.
   */
  parkedMap: ViewState | null = null
  /**
   * `true` while the reader has asked for the map without its tracks.
   *
   * The third stop of the map/tracks cycle. A field rather than a key in the
   * state, and that is the one thing about it worth knowing: it survives every
   * navigation of this session and is not in a link, because it is furniture
   * around the picture rather than any part of what the picture is *of*.
   *
   * @internal SessionCommands words the map key by it.
   */
  mapOnly = false
  /**
   * The map view's Tracks card, told when the lanes are put away (`V`).
   *
   * @internal SessionDeck tells it when a tracks cell is renamed.
   */
  trackCard: AnnotationCard | null = null
  /**
   * The Structures card (§25), rebuilt with the Tracks card it sits under.
   *
   * @internal SessionDeck lights its eyes when the deck's models change.
   */
  structureCard: StructureCard | null = null
  /**
   * @internal SessionDeck leads a deck with it in the 1D browser,
   * SessionCommands sends the browser's keys to it, and SessionRouter moves it
   * to a state's locus.
   */
  browser: BrowserView | null = null
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
   * The map's **level** (§7.3), at the head of the Sequences card.
   *
   * One element for the session's life, handed to every card built and filled
   * per view by {@link paintLevel}: the level belongs to the view on screen and
   * the list does not, so a change of view must not rebuild the list.
   */
  private readonly levelSlot = el('div', { class: 'seq-level hidden' })
  /** Which list a metagenome's card holds; see {@link paintMetaSequences}. */
  private metaScope: MetaScope | null = null
  /** That card's ticks — never persisted: on a metagenome they follow the view. */
  private metaSelection: SequenceSelection | null = null
  /** The card's rows in their own order, which is the order ticks are drawn in. */
  private metaOrder: string[] = []
  /**
   * Files whose bin-level whole-file read this tab could not allocate (§7.3).
   *
   * Kept for the session rather than the view: the machine's memory did not
   * change because the reader navigated, so the level stays greyed out and a
   * link or the back button asking for it lands one level up instead.
   */
  private readonly binRefused = new Set<string>()
  /** The file whose next whole-file view starts its read at once; see {@link refuseBinLevel}. */
  private startNext: string | null = null
  /** Contig → genome, built once per contigs table; see {@link genomeOfContig}. */
  private contigOwners: { from: ContigsResult; owners: Map<string, string> } | null = null
  /**
   * A config waiting for the file it describes.
   *
   * An exported session names its file; a local one cannot be re-opened from a
   * name, so the config sits here while the picker asks for it and is applied to
   * whatever is dropped next. Cleared when it is used, so a reader who ignores
   * the note and opens something else entirely gets that file plain.
   */
  private pendingConfig: SessionConfig | null = null
  /** Lets go of the connected folders' announcements; see {@link foldersChanged}. */
  private readonly stopFolders: () => void
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
   * The Analysis column and drawer, and the workspace behind them (§18):
   * `SessionAnalysis`, which builds the workspace once a file is open and
   * answers its questions from this session.
   *
   * @internal SessionDeck refreshes its workspace when the star or the maps
   * beside it move.
   */
  readonly analysis = new SessionAnalysis(this)
  private generalOn = false
  private annotationsOn = false
  private aestheticsOn = false
  private analysisOn = false
  /** @internal Re-read by the collaborators after each of their awaits, as here. */
  destroyed = false
  /**
   * The file this session's note is about, by its path before `::` (`null`
   * where none was open), or `null` itself while no note of its is up (§5.6).
   *
   * Everything a session says is a fact about the file it has open: a
   * sequence that reads as circular, an origin set, an edit not drawn. So it
   * goes when the tab moves to another file or to none ({@link unsay}) — a
   * banner naming chrY stayed up over a chicken map with no chrY after a link
   * moved the tab there. A change of resolution is the same file, and keeps it.
   */
  private said: { file: string | null } | null = null
  /**
   * This session holds a view state it has not acted on yet.
   *
   * The state of a tab that was restored and not clicked. It is a real state —
   * the tab is labelled from it and the address bar could be written from it —
   * and no byte of the file behind it has been read. Clicking is what reads it,
   * which is the whole of what makes remembering eight tabs cheap.
   */
  private primed = false
  /**
   * Whether anything has ever been mounted here; see {@link activate}.
   *
   * @internal SessionRouter sets it on the first render.
   */
  painted = false
  /**
   * The window: the one thing a session reports to ({@link SessionHost}).
   *
   * @internal The collaborators report through it as the session does.
   */
  readonly host: SessionHost

  constructor(host: SessionHost, id?: string) {
    this.host = host
    this.id = id ?? `s${nextSessionId++}`
    this.picker = new FilePicker({
      onOpen: (uri, source) => void this.openWithConfig(uri, source),
      onOpenFiles: (files) => void this.openFiles(files, { fromLanding: true }),
      onPicked: (picked) => this.openPickedHere(picked),
      // Neither door in an embed, whose landing page is *Load files* alone
      // (§21.2): the drawer a tile opens is not built there, and nor is the
      // Files column a place is connected into — so a tile pressed did
      // nothing, and a folder chosen was connected into a column nobody could
      // see. Left out, the picker draws neither section.
      ...(embedded()
        ? {}
        : {
            // The tiles are the shell's door: a store is a drawer over the
            // window, not a fact about this tab (`ui/StoreDrawer.ts`).
            onStore: (id: string) => this.host.openStore(id),
            // And so is a place: a connected folder belongs to the window's
            // Files column, which every tab shares (§20.4). Two callbacks
            // because two things can happen — a dialog opens on the place, or
            // *choose a folder…* has already been through the picker and has
            // one.
            onConnect: (provider: ProviderId) => this.host.openConnect(provider),
            onConnected: (id: string) => this.host.folderConnected(id),
            // The tutorial's offer, and the shell's for the same reason a store
            // is: its first step is the window's drawer, and it plays across
            // tabs (§30).
            ...(this.host.startTutorial === undefined
              ? {}
              : { onTutorial: (from: 'start' | 'resume') => this.host.startTutorial?.(from) }),
          }),
    })
    this.store.subscribe((state, change) => {
      this.host.stateChanged(this, change)
      void this.render(state)
    })
    this.stopFolders = subscribeFolders(() => this.foldersChanged())
  }

  /**
   * A folder was connected or let go (§20.6). A workspace's files the
   * installed app knows the places of may be in it: its tracks are tried
   * again, and so is the file this session is of while it is still asking for
   * it — without a gesture, since connecting the folder was the gesture.
   */
  private foldersChanged(): void {
    if (this.destroyed) return
    this.annotations?.loader.refind()
    if (this.file !== null) return
    const config = this.pendingConfig
    if (config !== null) {
      if (!hasLocation(config.state.uri)) return
      void (async () => {
        const source = await resolveSource(config.state.uri)
        if (source === null || this.destroyed || this.pendingConfig !== config || this.file !== null) return
        await this.openWithConfig(config.state.uri, source)
      })()
      return
    }
    // A view state naming a local file — a restored tab, a workspace's — that
    // was waiting on its picker: rendered again, it asks for the file again,
    // and finds it in the folder now.
    const state = this.store.state
    if (state !== null && hasLocation(state.uri)) void this.render(state)
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

  /**
   * The address of the file open here, as the hash names it, or `null` until
   * one has opened — which is later than the hash names it, by the length of
   * the open.
   */
  get fileUri(): string | null {
    return this.file?.uri ?? null
  }

  /** The bin size of the map open here, or `null` with none, or none fixed. */
  get binsize(): number | null {
    return this.file?.info.binsize ?? null
  }

  /**
   * Where a stretch of one sequence is drawn on the map in front, as the square
   * it makes on the diagonal, in viewport pixels; `null` with no map in front
   * or where it does not draw one (`MatrixPanel.squareOf`). For the tutorial
   * (§30), which lights the square it asks a reader to drag across.
   */
  squareOnScreen(stretch: { contig: string; start: number; end: number }): DOMRect | null {
    return this.current?.panel?.squareOf(stretch) ?? null
  }

  /**
   * The score the map in front is drawn from, by its picker's id — `balanced`,
   * `correlation` — with the file's default applied, which the view state leaves
   * out ({@link scoreOf}); `null` with no map. For the tutorial (§30).
   */
  get scoreInForce(): string | null {
    const state = this.state
    return state === null || this.file === null ? null : this.scoreOf(state).id
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

  /**
   * The reader client of the file open here, or `null` while none is.
   *
   * *While none is*, and not *where nothing has ever been opened*: the picker
   * starts its reader before anything is chosen ({@link warmReader}), so a tab
   * on the picker holds a worker with no file in it. The status bar reads this
   * to decide whether *read* and *validation* are on it (§6.3), and handed that
   * worker it showed both on a tab switched back to — a counter of nothing, and
   * a check that failed on the press, there being no file to scan.
   */
  get client(): ReaderClient | null {
    return this.file === null ? null : this.reader
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
    // The word the strip is made of (§26.4). Every control that reaches this tab
    // says *tab* — the `+` beside it, the palette's *New tab*, *Close this tab*,
    // *Rename this tab* — and the label on the only one there is said *session*,
    // which is this codebase's own word for the object rather than the reader's
    // for the thing on screen.
    return 'New tab'
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
    // The circle's rings follow each section's contigs, whatever the square
    // beside it is read at (§7.6): a genome × genome circle draws a contig's GC
    // along its genome's arc, and no circle draws a bin's weight — nor do the
    // two lines' lanes, which hold what the rings hold.
    if (this.current.panel.circleLit === true || this.current.panel.linesLit === true) return 'contig'
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
    void downloadBlob(
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
    this.deck.grid?.repaint()
    this.metadataCard?.refresh()
  }

  /** Re-measure whatever is mounted; a column moved or the window resized. */
  relayout(): void {
    this.current?.panel?.remeasure()
    this.current?.remeasure?.()
    this.deck.grid?.relayout()
    this.analysis.workspace?.relayout()
  }

  destroy(): void {
    this.destroyed = true
    this.stopFolders()
    // What it said goes with the tab.
    this.unsay()
    // The stage goes with the tab; the edit it made is kept with the file.
    this.editStage?.close()
    // The picker outlives every file this session opens and is torn down with
    // the tab, so its one subscription is released here rather than on each
    // navigation back to it.
    this.picker.destroy()
    this.minimap?.destroy()
    this.minimap = null
    this.analysis.drop()
    this.current?.destroy?.()
    this.current = null
    this.deck.destroy()
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.annotations?.client.destroy()
    this.annotations = null
    this.knownStructures = null
    this.compare.release()
    this.correlator?.terminate()
    this.correlator = null
    this.assembly = null
    this.sequenceListener?.()
    this.sequenceListener = null
    this.metaScope = null
    this.metaSelection = null
    this.contigOwners = null
    this.reader?.terminate()
    this.reader = null
  }

  // -------------------------------------------------------------------------
  // Commands this session can answer
  // -------------------------------------------------------------------------

  /**
   * Every command this session answers, asked afresh each time it is wanted
   * (`SessionCommands`).
   */
  private readonly palette = new SessionCommands(this)

  /**
   * The actions that are about *this file*, for the shell to merge with its own.
   *
   * Rebuilt on demand so `enabled` reflects the state the user is actually in;
   * the shell's own list is built the same way and for the same reason.
   */
  commands(): Command[] {
    return this.palette.all()
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
   *
   * @internal SessionCommands names and enables `<` and `>` by it.
   */
  stepTarget(delta: number): string | null {
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
    // `<` and `>` walk the order the lists are in, the reader's (§7.6).
    if (state.view === 'genome' && state.genome !== undefined) {
      return neighbour(this.arrangedGenomes(), state.genome, delta)
    }
    if (state.view === 'region' && state.region !== undefined && state.region2 === undefined) {
      const names = this.arrangedContigNames()
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
   * the map has: `<` and `>` walk the file's own order, one sequence at a time.
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

  /** @internal SessionCommands runs `<` and `>` with it. */
  step(delta: number): void {
    const state = this.store.state
    const target = this.stepTarget(delta)
    if (state === null || target === null) return
    if (state.view === 'browser') this.navigate({ ...state, locus: target })
    else if (state.view === 'genome') this.navigate({ uri: state.uri, view: 'genome', genome: target })
    else this.navigate({ ...state, region: target })
  }

  /**
   * Contig names, if the contigs table has already been read.
   *
   * @internal SessionDeck names the lead's contigs with it, and the tutorial
   * finds a row of the Chromosomes table by it (§30).
   */
  contigNames(): string[] | null {
    const table = this.file?.contigs
    if (table === undefined || table === null) return null
    const names = table.table.data['name']
    return Array.isArray(names) ? (names as string[]) : null
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

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

  /** The worker, built the first time anything needs one. */
  /**
   * Start the reader worker while the picker is on screen, before any file is
   * chosen.
   *
   * The worker starts fetching and instantiating h5wasm the moment it exists —
   * 4.8 MB, compiled — and it was only made by the first open, so every first
   * open waited for all of it between the click and the first byte of the file:
   * 2.6 of the 3.2 seconds it took a 1 GB `.mcool` dropped on a fresh tab to
   * land, measured. Made here, when the page is idle, the runtime is ready by
   * the time anyone has found their file. Only for the picker a reader is
   * looking at, and only once: a tab restored with a map open makes its worker
   * straight away, and one with a genome never needs this one.
   *
   * The picker asking for a map's file is one of them — a workspace's, or a
   * restored tab's, whose map is on this machine — and it used to be passed
   * over: the file a workspace named was dropped on a page with no reader, and
   * waited for one. From disk, a chromosome or a locus of the three maps
   * `notebooks/timing.qmd` times took 1.18 s to draw from such a page, and
   * takes 0.96 s now, medians of eleven pictures.
   *
   * @internal SessionRouter starts the reader under the picker.
   */
  warmReader(): void {
    if (this.reader !== null || this.warming) return
    this.warming = true
    const start = (): void => {
      this.warming = false
      if (this.destroyed || this.reader !== null || this.file !== null || this.assembly !== null) return
      // Only a head start: a host that cannot make the worker now (a DOM test
      // has none) leaves it to the first open, which makes it or says why not.
      try {
        this.clientOf()
      } catch {
        // the first open tries again
      }
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 2000 })
    else window.setTimeout(start, 500)
  }

  private warming = false

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
    // A wait for the picture the workspace describes (`perf/rendered.ts`): its
    // file is resolved before anything is opened or routed.
    const end = begin()
    try {
      await this.openConfigNow(config)
    } finally {
      end()
    }
  }

  /** What {@link openConfig} does. */
  private async openConfigNow(config: SessionConfig): Promise<void> {
    setPlotOptions(config.plot)
    this.host.applyPanelLayout(config.panels)
    // Where its files are, in the installed app's kept folders (§20.6), before
    // the first of them is asked for.
    adoptFolders(config.folders)
    const source = await resolveSource(config.state.uri, { prompt: true })
    if (this.destroyed) return
    if (source === null) {
      this.pendingConfig = config
      this.showContent(this.pickerWithConfig(config))
      this.host.sessionChanged(this)
      // A picker asking for the map: its reader starts while the file is found.
      this.warmReader()
      return
    }
    this.pendingConfig = config
    await this.openWithConfig(config.state.uri, source)
  }

  /**
   * Put a note up about the file at `uri` — the one open, where none is named —
   * in the bar under the tabs, as this session's (see {@link said}).
   */
  private say(message: string, uri: string | undefined = this.file?.uri ?? this.assembly?.uri): void {
    this.said = { file: uri === undefined ? null : splitUri(uri).path }
    this.host.notify(message, this)
  }

  /**
   * Take this session's note down, unless it is about the file at `uri`: the
   * file it is moving to, which may be the same one at another resolution.
   * With no `uri` the tab is going to no file at all, and it goes.
   *
   * @internal SessionRouter takes the note down when a state names another
   * file.
   */
  unsay(uri?: string): void {
    if (this.said === null) return
    if (uri !== undefined && this.said.file === splitUri(uri).path) return
    this.said = null
    this.host.withdrawNotice(this)
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
  private noteSourceMismatch(uri: string, config: SessionConfig, source: SourceSpec): void {
    const saved = config.source
    if (saved === undefined || source.kind !== 'local') return
    const file = source.file
    if (file.name !== saved.name) return
    const sizeMoved = saved.size !== undefined && saved.size !== file.size
    const timeMoved = saved.lastModified !== undefined && saved.lastModified !== file.lastModified
    if (!sizeMoved && !timeMoved) return
    const was = sourceNote(saved)
    const now = sourceNote({ name: file.name, size: file.size, lastModified: file.lastModified })
    this.say(
      `${file.name} is not the file this session was made from — that one was ${was ?? 'different'}` +
        `, this one is ${now ?? 'different'}. The session has opened; the numbers in it are this ` +
        'file’s.',
      uri,
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
  async openConfigUrl(
    rawUrl: string,
    /** What to call it where its address says only an id: a Drive file's name (§24.9). */
    label?: string,
  ): Promise<void> {
    // A wait for the picture the workspace describes, from the moment it is
    // asked for (`perf/rendered.ts`): the fetch comes before anything opens.
    const end = begin()
    try {
      await this.openConfigUrlNow(rawUrl, label)
    } finally {
      end()
    }
  }

  /** What {@link openConfigUrl} does. */
  private async openConfigUrlNow(rawUrl: string, label?: string): Promise<void> {
    // `?config=` is the other road a URL arrives on — a link, not a box — so the
    // rewrite table runs here the way it runs in `inferSource` for `#uri=`
    // (SPECS §24.5). A workspace published on Drive or named `gs://` is fetched
    // from the address that serves it, and the names inside it are then resolved
    // against that address by `resolveConfig`, which canonicalises them too.
    const url = canonicalUrl(rawUrl)
    const name = label ?? fileLabel(url)
    this.showContent(loading(`Reading ${name}`))
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
          `${name} could not be read: the host answered ${response.status} ` +
            `${response.statusText}${credential === null ? '' : ' to a signed request'}.`,
        )
      }
      if (this.destroyed) return
      // …and the same hop for a published one, with the URL it was found at, so
      // the relative names inside it resolve against that folder.
      this.host.openWorkspaceFile(await response.text(), name, url)
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
    this.noteSourceMismatch(uri, config, source)
    // The map the workspace named *inside* its file — `::/resolutions/25000` of
    // an `.mcool`, an entry of an `.mmetacool` — rides on the file that answers
    // for it. A dropped file is named by its path alone, and opened at its root
    // it landed on a rung of the file's own choosing rather than the one the
    // workspace was saved at (§3.4), under a key its tracks were not written to.
    const named = splitUri(config.state.uri).group
    if (source.kind === 'local' && splitUri(uri).group === '/' && named !== '/') uri = `${uri}::${named}`
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
  async openFiles(files: readonly File[], options: { fromLanding?: boolean } = {}): Promise<void> {
    // A wait for the picture the drop ends in (`perf/rendered.ts`): between the
    // drop and the first open, a file is being read for what it is and nothing
    // on screen says a picture is coming.
    const end = begin()
    try {
      await this.openFilesNow(files, options)
    } finally {
      end()
    }
  }

  /** What {@link openFiles} does. */
  private async openFilesNow(files: readonly File[], options: { fromLanding?: boolean }): Promise<void> {
    if (files.length === 0) return
    const config = files.find((file) => looksLikeConfig(file.name))
    if (config !== undefined) {
      // A config among the files decides everything, and the rest are what it
      // was asking for: the session it describes, then its own file dropped
      // alongside it, which is exactly the two-step the note asks for done in
      // one gesture.
      await this.openConfigFile(config)
      this.droppedAll(files.filter((file) => file !== config))
      this.landingOpened(options)
      return
    }
    if (files.length === 1) {
      await this.openLocal(files[0])
      this.landingOpened(options)
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
    await this.openLocal(lead, leadPair.index)
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
    this.landingOpened(options)
  }

  /**
   * Open a dropped file — through the workspace or the view waiting for it,
   * where one is.
   *
   * A workspace or a link naming a local file asks for it to be dropped, and
   * promises the rest of its view back when it is (`pickerWithNote`). One file
   * dropped on that page went through a pending workspace; two — the map and a
   * track beside it — opened the map as a stranger. Both now take its door.
   */
  private async openLocal(file: File, index?: File): Promise<void> {
    const source: SourceSpec = { kind: 'local', file }
    if (this.pendingConfig !== null && index === undefined) {
      await this.openWithConfig(file.name, source)
      return
    }
    // A view waiting on this page for this file — a link or a workspace that
    // named it — named the map inside it as well: opened by its path alone, an
    // `.mcool` landed on a rung of its own choosing, and the view the page had
    // promised back (`pickerWithNote`) was dropped for its Chromosomes table.
    const waiting = this.file === null ? this.store.state : null
    const named = waiting !== null && splitUri(waiting.uri).path === file.name ? waiting.uri : file.name
    await this.open(named, source, undefined, index)
  }

  /**
   * A row out of the Files column or a store, let go on this tab's landing
   * page (§20.5, §24.2): opened here with all the row carries — the index found
   * beside it, the name a store gave it — where its address alone lost both. A
   * file on this machine goes through {@link openFiles}, the door a dropped one
   * takes, which is also what a workspace or a link waiting for its file
   * answers to (§5.6); a page waiting for one takes a remote file by its own
   * door, and an empty tab with nothing waiting fills as the row's `+` would
   * fill it. Not counted as the landing page's own open: the Files column
   * stays where it is, the reader having just been working in it.
   */
  private openPickedHere(picked: PickedFile): void {
    if (picked.source.kind === 'local') {
      const file = picked.source.file
      void this.openFiles(picked.index === undefined ? [file] : [file, picked.index])
      return
    }
    if (this.pendingConfig !== null) {
      void this.openWithConfig(picked.uri, picked.source)
      return
    }
    void this.addPicked(picked)
  }

  /** Tell the shell a landing-page open has produced a view, if it has. */
  private landingOpened(options: { fromLanding?: boolean }): void {
    if (!options.fromLanding || this.destroyed || this.state === null) return
    this.host.landingFileOpened(this)
  }

  async open(
    uri: string,
    source: SourceSpec,
    carry?: ViewState,
    index?: File,
    binning?: PairsBinning,
    label?: string,
  ): Promise<void> {
    // A wait for the picture the file is opened for (`perf/rendered.ts`). Most
    // opens are already inside a render, which waits too; a rung picked, an
    // entry chosen or a store row pressed is not, and opens before it renders.
    const end = begin()
    try {
      await this.openNow(uri, source, carry, index, binning, label)
    } finally {
      end()
    }
  }

  /** What {@link open} does; its arguments are explained here. */
  private async openNow(
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
    /**
     * What the file is called, where the address does not say — the name a
     * Drive folder or a store row gave it (§24.9). It decides the door when
     * the address cannot, and it is what the loading screen and the tab say.
     */
    label?: string,
  ): Promise<void> {
    if (this.opening === uri) return
    // A file dropped, picked or chosen from a store opens without a state to
    // render first, so the note about the last one is taken down here too.
    this.unsay(uri)
    // An empty tab takes the file's name as its own, as {@link addRemote}'s
    // does. Read before anything below replaces what the tab holds.
    const wasEmpty = this.file === null && this.assembly === null
    // …and a genome being browsed as tracks, whose declarations a map of it
    // takes once it has opened (§8.15).
    const browsed = this.file === null && this.assembly !== null ? this.sessionKey() : null
    // A Drive address ends in an id and says nothing else; where nobody gave a
    // name, Drive is asked for it first (§24.9) — one small request that names
    // the loading screen and the tab, and decides the door where the bytes
    // would otherwise have to be asked.
    const found = label === undefined ? await this.driveName(uri, source) : null
    if (this.destroyed) return
    if (found !== null) label = found
    const named = (): void => {
      if (wasEmpty && found !== null && !this.destroyed && this.name === null) this.rename(found)
    }
    // A file that is not a contact map starts a genome browser instead. Decided
    // by name first — the address's, then the given one — and by the bytes
    // when neither says; see {@link routeOf}.
    const route = routeFor(uri, label)
    if (route === 'genome') {
      await this.openGenome(uri, source, carry?.locus, false, index, label)
      named()
      return
    }
    // A name that says nothing — a Drive id, a `yeast.txt` — is asked what it
    // is *before* the map door is tried, because that door's failure is dear:
    // HDF5 hunts for a superblock at doubling offsets, a megabyte chunk at
    // each, through the whole of a file that is not one. The question costs
    // one small read (`openUnknown`), and a map answers it as a map. So is a
    // `.json` that reached this door rather than the config road: it is a
    // workspace only there ({@link openWithConfig}), and here a file like any
    // other, asked before it is refused.
    let sniffed = false
    if ((route === 'unknown' || route === 'workspace') && binning === undefined) {
      sniffed = true
      if (await this.openUnknown(uri, source, carry, label)) {
        named()
        return
      }
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
    this.compare.carry(uri)
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
      `${binning === undefined ? 'Opening' : 'Binning'} ${label ?? fileLabel(uri)}`,
      () => task?.cancel(),
    )
    this.showContent(screen.el)
    this.host.sessionChanged(this)
    try {
      // `pairs/import.ts` weights its pass against the rungs so the bar does
      // not stall at 99%; the other two report bytes and then pixels.
      // Through the edit kept for this file, where there is one to draw (§27.7).
      const edit = this.editToOpen(uri)
      task = client.cancellable<'open'>(
        {
          kind: 'open',
          uri,
          source,
          ...(binning === undefined ? {} : { binning }),
          ...(edit === undefined ? {} : { edit }),
        },
        (done, total, note) => screen.report(done, total, note),
      )
      const info = await task.promise
      this.lens = edit !== undefined && info.edit?.refusal === null ? { edit, assembly: EditedAssembly.of(edit) } : null
      const refusal = info.edit?.refusal ?? null
      if (refusal !== null) this.say(`The edit kept for this file is not drawn. ${refusal}`, uri)
      // A new map in the worker is a map as stored (§6.5): whatever it was told
      // to draw the last one to went with it, and the render below tells it
      // again.
      this.drawn.delete(client)
      this.censuses.delete(client)
      this.counted.delete(client)
      this.opens.set(client, (this.opens.get(client) ?? 0) + 1)
      this.countOf(client, info)
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
      // A `.hic` opened by its own URL names no rung, and lands on one (§3.6):
      // the one it is drawn at, or the picker would stand on the finest.
      const landed =
        info.entryGroup === 'resolutions' && info.binsize !== null && entries.includes(String(info.binsize))
          ? String(info.binsize)
          : undefined
      const currentEntry = match === null ? landed : match[1]
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
        // The greyed *Genomes* on a plain cooler is §9's answer to "does this
        // viewer have one" — and while the multi-genome format is a dev feature
        // that is off (§29), the question is not one this page raises, so the
        // row is absent rather than greyed.
        rootChoices: isMetacool
          ? ['genomes', 'contigs', 'overview']
          : isScool
            ? ['cells', 'contigs', 'whole']
            : devFeature('metacool')
              ? ['genomes', 'contigs', 'whole']
              : ['contigs', 'whole'],
        ...(isMetacool
          ? {}
          : {
              disabledChoices:
                isScool || !devFeature('metacool')
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
        // The reader's own rungs, merged into the file's in bin-size order
        // (§3.4). Given even where the file has none to merge with: a plain
        // `.cool` has one resolution and the `+` beside it is the whole feature.
        ladder: () => this.ladderRungs(),
        coarsen: () => this.store.state?.coarsen,
        onSelectRung: (entry) => this.openStoredRung(entry),
        onSelectDerived: (binsize) => this.openDerived(binsize),
        onAddResolution: () => this.askResolution(),
        onDropResolution: (binsize) => this.dropResolution(binsize),
        contacts: this.contactsBoxFor(),
        ...(devFeature('edit') ? { reference: this.referenceChipFor() } : {}),
      })
      this.infoPanel = new InfoPanel({
        info,
        onCloseFile: (which) => this.compare.close(which),
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
      this.syncFileCard()
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
      // `compare.carried` is left standing until {@link SessionCompare.restore}
      // spends it, because it is also what tells `render` to leave the
      // comparison alone in the meantime — see the note there.
      const carried = this.compare.carried
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
      if (carried !== null) this.compare.restore(carried, uri, info)
      const moved = this.navigate(target, { replace: true })
      // `set` is a no-op when the state is already exactly what arrived, so
      // render explicitly in that case — and only in that case, to avoid
      // mounting the same view twice.
      if (!moved) void this.render(this.store.state)
      named()
      // A circle ticked and an origin set while the genome was browsed as
      // tracks are about the molecules this map is of (§8.15).
      if (browsed !== null) this.carryDeclarations(browsed)
      // The Sequences card was painted before the navigation, while the state
      // still named whatever this session held — a genome browsed as tracks,
      // another map — so its circles were read under that file's key and would
      // never show this one's. Again, under this map's.
      if (this.sequencesKey !== this.sessionKey()) this.paintSequences()
      // Not awaited: three small reads per sequence, on the file's first open
      // only, and nothing on screen waits for them (§8.15). After the
      // navigation, because the declarations are kept under the key of the file
      // the *state* names: asked before it, the store was the previous file's,
      // so a file opened over one already measured was never measured, and one
      // opened over a measurement still running had its ticks written there.
      // And after the map's first block: fifty corner reads queued in the same
      // reader as the picture's first read are fifty reads it waited behind.
      void this.firstPicture().then(() => this.detectCircular(uri))
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
      if (route === 'unknown' && !sniffed && (await this.openUnknown(uri, source, carry, label))) return
      // A text table's name whose bytes no reader took — they were asked above —
      // is refused as the text it is. The map door's refusal, *not an HDF5
      // file*, is true of a `notes.txt` and says nothing a reader can act on;
      // the door is still tried, for a `.pairs` saved under a name like that.
      const text = isTextTableName(uri) || (label !== undefined && isTextTableName(label))
      if (sniffed && text && err instanceof ViewerError && err.code === 'not-hdf5') {
        const name = label ?? fileLabel(uri)
        this.showError(new ViewerError('not-a-table', `${name} is text, and no reader here took its rows as a table.`), uri, source)
        return
      }
      this.showError(err, uri, source)
    } finally {
      this.opening = null
      // An open that failed, or was redirected into an entry and handled there,
      // leaves nothing to carry: a note still standing would go on telling
      // `render` that a second file is on its way when nothing is coming.
      this.compare.carried = null
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
    // Where it goes first, from the press: writing every rung of a ladder takes
    // far longer than a browser will still open a save dialog for once the
    // press is over (`ui/export.ts`), and a reader who cancels here has not
    // waited for a file nobody wanted.
    const target = await chooseSaveTarget(
      mcoolNameFor(splitUri(this.file?.uri ?? 'pairs').path),
      'application/x-hdf5',
    )
    if (target === null) return
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
      await target.write(new Blob([result.bytes as BlobPart], { type: 'application/x-hdf5' }))
      note.finish(`${target.name} — ${result.rungs.length} resolutions`)
    } catch (err) {
      if (isCancellation(err)) {
        note.dismiss()
        return
      }
      note.fail(`Could not write the .mcool: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * What Drive calls a file addressed by id, where the caller gave no name.
   *
   * One `files.get` on the key or token the read itself carries, memoised by
   * `browse/driveName.ts`; `null` for any other address, and for a Drive that
   * will not say — the open then goes ahead under the id, as it always did.
   */
  private async driveName(uri: string, source: SourceSpec): Promise<string | null> {
    if (source.kind !== 'remote') return null
    return driveFileName(splitUri(uri).path)
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
    label?: string,
  ): Promise<boolean> {
    // Hoisted above the `try` and released in the `finally`, as `openGenome`
    // does: the request starts a worker lazily and every failure path here is
    // reachable — an empty file, a truncated header, a fetch that 404s — and a
    // worker that is never terminated is a thread for the life of the page.
    const client = new AnnotationClient()
    let result: AssemblyResult
    try {
      result = await client.request<'assembly'>({ kind: 'assembly', source: toWire(source) })
      if (result.format === null || result.format === 'hdf5' || result.contigs.length === 0) {
        return false
      }
    } catch {
      return false
    } finally {
      client.destroy()
    }
    if (this.destroyed) return false
    // The answer travels: the genome door would otherwise ask the same
    // question of the same bytes a second time, over the same slow host.
    await this.openGenome(uri, source, carry?.locus, false, undefined, label, result)
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
   *
   * @internal SessionRouter opens the genome a state names.
   */
  async openGenome(
    uri: string,
    source: SourceSpec,
    locus?: string,
    insist = false,
    index?: File,
    label?: string,
    known?: AssemblyResult,
  ): Promise<void> {
    // A wait for the browser it opens, as {@link open} is for a map.
    const end = begin()
    try {
      await this.openGenomeNow(uri, source, locus, insist, index, label, known)
    } finally {
      end()
    }
  }

  /** What {@link openGenome} does; its arguments are explained here. */
  private async openGenomeNow(
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
    /** What the file is called where its address does not say (§24.9). */
    label?: string,
    /** The assembly question, already answered by {@link openUnknown} for the same bytes. */
    known?: AssemblyResult,
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
    // As {@link open} does, for the genome a file is browsed as.
    this.unsay(uri)
    // Asked again here for the door a `view=browser` link comes through
    // directly; from {@link open} the answer is already in hand and costs nothing.
    if (label === undefined) label = (await this.driveName(uri, source)) ?? undefined
    if (this.destroyed || this.opening === uri) return
    this.opening = uri
    this.noteGrant(uri, source)
    this.showContent(loading(`Reading ${label ?? fileLabel(uri)}`))
    this.host.sessionChanged(this)
    const client = new AnnotationClient()
    try {
      const result =
        known ?? (await client.request<'assembly'>({ kind: 'assembly', source: toWire(source) }))
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
        name: label ?? fileLabel(uri),
        contigs: result.contigs,
        origin: result.origin,
      })
      this.carry(uri)
      this.tearDown()
      this.assembly = assembly
      this.assemblySource = source
      // A model dropped on an empty window opens as its model (§25.3), not as
      // the axis it happens to name: the browser it makes has nothing to draw.
      // Not on a restore — a link names its own deck, and the reader's own
      // arrangement of it is in this session's memory.
      this.structureAlone = !insist && result.format === 'structure'
      // The trail for a genome, built here because `tearDown` has just dropped
      // the file's (§5.8): a browser is a view like any other and says where in
      // the assembly it is.
      this.breadcrumb = this.browserBreadcrumb(assembly)
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
            label,
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

  /**
   * Call the track read from `url` by `label`, where one is already seated.
   *
   * For the one road on which a name arrives after the row does: a genome
   * file opened *as* a browser is seated by `openGenome` under the URL's last
   * segment, and the store row that named it better has nothing to hand the
   * label to until then. Compared on the address without its `#index=`
   * fragment, which is what the loader keeps.
   */
  relabelTrack(url: string, label: string): void {
    const held = this.annotations
    if (held === null) return
    const { address } = splitIndexFragment(url)
    for (const entry of held.store.entries) {
      if (entry.source.kind !== 'remote' || entry.source.url !== address) continue
      if (entry.label !== label) held.store.update(entry.id, { label })
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
    return [this.current?.panel, this.deck.grid, this.browser]
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
    store.subscribe(() => {
      this.host.sessionChanged(this)
      this.watchStructureRows(store)
    })
    const manual = new ManualStore(scope)
    const client = new AnnotationClient()
    const lengths = new Map(assembly.contigs.map((contig) => [contig.name, contig.length]))
    // An assembly's contigs are already `{ name, length }`, which is what the
    // loader's rename wants (§5.9).
    const loader = new AnnotationLoader(store, client, assembly.contigs, (files) =>
      this.considerLengths(files),
    )
    // A new store means the workspace that was watching the old one is stale:
    // it subscribes to the store it was *built* with, while `adopt` writes
    // through `host.store()` to whichever is current — so a workspace that
    // outlived its store would hold the numbers for rows the Tracks card no
    // longer lists, and export nothing when one of them asked. Destroyed here
    // rather than reconciled: a workspace is per-file, and so is a store.
    this.analysis.drop()
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
    // The tracks published beside this genome, as one click — the same offer the
    // map path makes, and until now the one thing a browser session did not
    // inherit from it. It matters most for exactly the rows this release added:
    // a **track hub's** assembly opens as a `.2bit` or a `chrom.sizes` and its
    // whole trackDb rides along as the shelf (§24.10), so without this the
    // *open with its tracks* verb on a hub's heading opened the genome and
    // silently dropped the tracks. An IGV genome row carries the same shelf and
    // was losing it the same way.
    const published = demoAnnotationsToOffer(assembly.uri, {
      restoring: AnnotationStore.stored(scope).length > 0,
    })
    // …and whether they were **asked for** rather than merely brought along.
    // *Open with its tracks* is a sentence that has to come true, so that road
    // loads them here and shows no button; every other road to the same file
    // keeps the offer (`ui/examples.ts`).
    const wanted = published.length > 0 && shelfWasAsked(assembly.uri)
    this.setAnnotations([
      this.compareCard.el,
      new AnnotationCard({
        store,
        loader,
        context: 'browser',
        onPickDropped: (event) => this.pickDropped(event),
        ...this.syntheticRowHooks(),
        ...(published.length === 0 || wanted
          ? {}
          : {
              demo: {
                label: `load the ${published.length} tracks published with this genome`,
                hint:
                  'The tracks the store or hub this genome came from lists beside it, on its own ' +
                  'assembly. They open the same way any remote file does.',
                run: () => {
                  for (const entry of published) {
                    loader.addUrl(entry.url, entry.label)
                  }
                },
              },
            }),
      }).el,
      this.structureCardFor(store, loader),
      this.manualCard.el,
    ])
    this.setGeneral([this.genomeCardFor(assembly)])
    this.noteRestoredStructures(scope)
    loader.restore(AnnotationStore.stored(scope))
    // The tracks the reader asked for, put on. After the cards are mounted and
    // after `restore`, for `restore`'s own reason: a row landing in a list that
    // does not exist yet is a row nobody draws, and a row landing *before* the
    // restored ones would reorder a lane stack the reader arranged last time.
    if (wanted) {
      for (const entry of published) loader.addUrl(entry.url, entry.label)
    }
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
   *
   * @internal SessionDeck sends a structure cell's pick through it.
   */
  goToLocus(locus: string): void {
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
   * **A metagenome gets the same card over its own two units**
   * ({@link paintMetaSequences}): its genomes over a picture of genomes, and one
   * genome's contigs inside one — never the file's whole contig list, which is
   * a hundred thousand pieces of four thousand assemblies and not a picker.
   *
   * Built once per file — the list arrives with the `/chroms` read that
   * {@link setUpAnnotations} already pays for — and never rebuilt: the ticks
   * follow the view through the selection, so rebuilding would only throw away
   * the filter text and the scroll position of a list being read.
   */
  /** The key the Sequences card's circles were read under; see {@link open}. */
  private sequencesKey: string | null = null

  /** @internal SessionRouter paints the card again when the map comes back. */
  paintSequences(): void {
    const file = this.file
    const panel = this.infoPanel
    if (file === null || panel === null) return
    this.sequencesKey = this.sessionKey()
    if (file.info.hasGenomes) {
      this.paintMetaSequences(this.metaScope ?? { kind: 'genomes' })
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
    const circular = this.circularColumn()
    panel.setSequences(
      sequenceCard({
        contigs: assembly.contigs,
        selection,
        // Read-only here: the declaring is done in the Chromosomes table, and
        // what this list owes a reader at work is the answer rather than a
        // second place to click (§8.15).
        ...(circular === null ? {} : { circular }),
        // The same destination a click on a row of the Chromosomes table
        // reaches, because it is the same act: show me that chromosome.
        onGoTo: (name) => this.navigate({ uri: file.uri, view: 'region', region: name }),
        head: [this.levelSlot],
        ...MAP_TICKS,
      }),
    )
  }

  /**
   * The Sequences card of a **metagenome**: its genomes, or one genome's contigs.
   *
   * Which one is the view's to say (`metaScopeOf`): a picture of genomes — the
   * whole metagenome, a pair, several ticked — lists the genomes, and a picture
   * inside one genome lists that genome's contigs, so ticking several of either
   * is the same gesture a cooler's chromosomes answer. A name's click goes one
   * level in (a genome, or a contig of it) and the line under a contig list's
   * title goes one level out.
   *
   * Rebuilt when the list changes and not otherwise, for the reason the
   * cooler's card is built once: the ticks follow the view, and a rebuild would
   * throw away the filter and the scroll of a list being read.
   */
  private paintMetaSequences(scope: MetaScope): void {
    const file = this.file
    const panel = this.infoPanel
    if (file === null || panel === null) return
    const rows = this.metaRows(scope)
    const selection = new SequenceSelection()
    this.sequenceListener?.()
    this.sequenceListener = selection.subscribe(() => this.metaChosen())
    this.metaScope = scope
    this.metaSelection = selection
    this.metaOrder = rows.map((row) => row.name)
    const uri = file.uri
    const head: HTMLElement[] = [this.levelSlot]
    if (scope.kind === 'contigs') {
      head.unshift(
        el(
          'p',
          { class: 'hint seq-scope' },
          el('span', { text: 'of ' }),
          el('strong', { text: scope.genome }),
          el('span', { text: ' · ' }),
          button('↑ genomes', () => this.navigate(viewForMeta(uri, { kind: 'genomes' }, [scope.genome])), {
            class: 'seq-all',
            title: 'Back to the list of genomes, with this one ticked',
          }),
        ),
      )
    }
    panel.setSequences(
      sequenceCard({
        contigs: rows,
        selection,
        head,
        onGoTo: (name) =>
          this.navigate(
            scope.kind === 'genomes'
              ? { uri, view: 'genome', genome: name }
              : { uri, view: 'region', region: name, genome: scope.genome },
          ),
        ...(scope.kind === 'genomes' ? GENOME_TICKS : CONTIG_TICKS),
        // The reader's order moved (§7.6): the rows again, in it.
        ...this.metaReorder(scope),
      }),
    )
  }

  /** The rows of a metagenome's card: its genomes, or one genome's contigs, in the reader's order. */
  private metaRows(scope: MetaScope): SequenceRow[] {
    return scope.kind === 'genomes' ? this.genomeRows() : this.contigRowsOf(scope.genome)
  }

  /** What tells a card of genomes or contigs its rows in a new order (§7.6). */
  private metaReorder(scope: MetaScope): Pick<SequenceCardProps, 'reordered'> {
    const store = this.orderStore()
    if (store === null) return {}
    return { reordered: { subscribe: (listener) => store.subscribe(() => listener(this.metaRows(scope))) } }
  }

  /** The genomes, in the reader's order (§7.6), `__unbinned__` left out. */
  private genomeRows(): SequenceRow[] {
    const file = this.file
    if (file === null) return []
    const names = file.genomes.table.data['name']
    const lengths = file.genomes.table.data['length']
    const lengthOf = new Map<string, number>()
    if (Array.isArray(names) && lengths !== undefined && !Array.isArray(lengths)) {
      ;(names as string[]).forEach((name, row) => lengthOf.set(name, Number(lengths[row])))
    }
    return this.arrangedGenomes().map((name) => ({ name, length: lengthOf.get(name) ?? 0 }))
  }

  /** One genome's contigs, in the reader's order (§7.6). */
  private contigRowsOf(genome: string): SequenceRow[] {
    const rows = this.fileContigRowsOf(genome)
    const placed = this.orderStore()?.current.contigs[genome]
    if (placed === undefined) return rows
    const byName = new Map(rows.map((row) => [row.name, row]))
    return arrange(
      rows.map((row) => row.name),
      placed,
    ).map((name) => byName.get(name) as SequenceRow)
  }

  /** One genome's contigs, in file order, from the contigs table's `genome_id`. */
  private fileContigRowsOf(genome: string): SequenceRow[] {
    const file = this.file
    const table = file?.contigs?.table
    const genomeNames = file?.genomes.table.data['name']
    if (table === undefined || !Array.isArray(genomeNames)) return []
    const index = (genomeNames as string[]).indexOf(genome)
    const names = table.data['name']
    const ids = table.data['genome_id']
    const lengths = table.data['length']
    if (
      index < 0 ||
      !Array.isArray(names) ||
      ids === undefined ||
      Array.isArray(ids) ||
      lengths === undefined ||
      Array.isArray(lengths)
    ) {
      return []
    }
    const rows: SequenceRow[] = []
    for (let row = 0; row < names.length; row++) {
      if (Number(ids[row]) === index) {
        rows.push({ name: (names as string[])[row], length: Number(lengths[row]) })
      }
    }
    return rows
  }

  /** The genome a contig belongs to, once the contigs table is in. */
  private genomeOfContig(contig: string): string | undefined {
    const contigs = this.file?.contigs ?? null
    if (contigs === null) return undefined
    if (this.contigOwners?.from !== contigs) {
      this.contigOwners = {
        from: contigs,
        owners: contigGenomes(contigs, this.file?.genomes.table ?? null),
      }
    }
    return this.contigOwners.owners.get(contig)
  }

  /** A tick changed on a metagenome's card: draw what is ticked, in list order. */
  private metaChosen(): void {
    if (this.echoingSequences) return
    const file = this.file
    const scope = this.metaScope
    const selection = this.metaSelection
    if (file === null || scope === null || selection === null) return
    const chosen = new Set(selection.names)
    this.navigate(viewForMeta(file.uri, scope, this.metaOrder.filter((name) => chosen.has(name))))
  }

  /**
   * {@link syncSequenceTicks} for a metagenome: pick the list the view is from,
   * then tick what it draws.
   *
   * A genome view does not read the contigs table, and one genome's list is
   * built from it — so the first visit to one reads it and comes back here.
   */
  private syncMetaTicks(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const names = this.contigNames() ?? []
    const scope = metaScopeOf(state, names, (contig) => this.genomeOfContig(contig))
    if (scope !== null && !sameScope(scope, this.metaScope)) {
      if (scope.kind === 'contigs' && file.contigs === null) {
        void this.contigs().then(
          () => {
            if (!this.destroyed && this.store.state === state) this.syncMetaTicks(state)
          },
          () => {},
        )
        return
      }
      this.paintMetaSequences(scope)
    }
    const current = this.metaScope
    const selection = this.metaSelection
    if (current === null || selection === null) return
    const shown = metaShown(state, current, names)
    if (shown === null) return
    this.echoingSequences = true
    try {
      selection.set(shown)
    } finally {
      this.echoingSequences = false
    }
  }

  /**
   * Fill the level slot for the view on screen, or empty it (§7.3).
   *
   * The level was a control inside each view — the Map card's `level` on a
   * genome, a pair and a cooler's whole genome, and a `Level` card of its own
   * over a metagenome's — and it is one question about the map: what one cell
   * holds. So it sits once, at the head of the list the map is picked from, and
   * says only what the view on screen can draw.
   *
   * @internal SessionRouter calls it after every mount; the DOM tests replace
   * it on the instance.
   */
  paintLevel(state: ViewState): void {
    const file = this.file
    // The overview's own default, which an advertised edge list moves to the
    // genome level (see {@link mountOverview}); the select must name what is drawn.
    const landing = state.level === undefined && this.edgeListUrl() !== undefined ? 'genome' : undefined
    const refused = this.binRefused.has(state.uri)
    const choices =
      file === null
        ? null
        : levelChoices(state, file.info.hasGenomes, file.info.nContigs, landing, refused)
    if (choices === null) {
      this.levelSlot.replaceChildren()
      this.levelSlot.classList.add('hidden')
      return
    }
    const select = el('select', { class: 'select' })
    for (const choice of choices.options) {
      const option = el('option', { value: choice.value, text: choice.label, title: choice.hint })
      option.disabled = choice.disabled === true
      select.appendChild(option)
    }
    select.value = choices.current
    const hint = (): string =>
      choices.options.find((choice) => choice.value === select.value)?.hint ?? ''
    select.title = hint()
    select.addEventListener('change', () => {
      select.title = hint()
      this.store.patch({ level: select.value as 'bin' | 'contig' | 'genome' }, { replace: true })
    })
    const binOffered = choices.options.some((choice) => choice.value === 'bin')
    this.levelSlot.replaceChildren(
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'level' }), select),
      ...(refused && binOffered
        ? [el('p', { class: 'hint seq-level-note', text: BIN_REFUSED })]
        : []),
    )
    this.levelSlot.classList.remove('hidden')
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
   *
   * @internal SessionRouter calls it after every mount; the DOM tests replace
   * it on the instance.
   */
  syncSequenceTicks(state: ViewState): void {
    const file = this.file
    if (file?.info.hasGenomes === true) {
      this.syncMetaTicks(state)
      return
    }
    const selection = this.sequences
    if (file === null || selection === null) return
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

  /**
   * A genome's own sequence list, as the Chromosomes table (§5.8).
   *
   * The table a cooler lands on, built from the assembly the browser was opened
   * with rather than from a file's `/chroms`: each sequence's name and length,
   * and the two columns that are declarations about the molecules rather than
   * about any one map — the circle and the origin (§8.15). Declared here, with no
   * map open, they are under this genome's key, and a map dropped in later takes
   * them for its own sequences of the same names ({@link carryDeclarations}).
   *
   * @internal SessionRouter mounts a genome's own table through it.
   */
  mountAssemblyContigs(state: ViewState): void {
    const assembly = this.assembly
    if (assembly === null) return
    const data: ContigsResult = {
      table: {
        length: assembly.contigs.length,
        columns: ['name', 'length'],
        data: {
          name: assembly.contigs.map((contig) => contig.name),
          length: Float64Array.from(assembly.contigs, (contig) => contig.length),
        },
      },
    }
    const circular = this.circularColumn()
    const origins = this.originColumn()
    const browse = (locus?: string): void => {
      this.navigate({ uri: state.uri, view: 'browser', ...(locus === undefined ? {} : { locus }) })
    }
    const view = new ContigsTable({
      data,
      title: 'Chromosomes',
      noun: 'chromosome',
      hint: 'The sequences this genome was opened with. Pick one to browse its tracks.',
      assembly,
      ...(this.annotations === null ? {} : { store: this.annotations.store }),
      ...(circular === null ? {} : { circular }),
      ...(origins === null ? {} : { origins }),
      persistence: this.tableMemory(state.uri, 'contigs'),
      onOpenContig: (contig) => browse(contig),
      onOpenRegion: (region) => browse(formatLocus(rangeOfRegion(region))),
      onOpenWhole: () => browse(),
    })
    this.showContent(view.el, view)
  }

  /** @internal SessionRouter mounts the 1D browser through it; the DOM tests call it. */
  mountBrowser(state: ViewState): void {
    const assembly = this.assembly
    const held = this.annotations
    if (assembly === null || held === null) return
    const view = new BrowserView({
      assembly,
      store: held.store,
      client: held.client,
      // A map read as tracks is read through its edit, as the map is (§27.7).
      edited: () => this.lens?.assembly ?? null,
      selection: this.selectionFor(assembly),
      ...(state.locus === undefined ? {} : { locus: state.locus }),
      onLocusChange: (locus) => this.store.patch({ locus }, { replace: true }),
      // The deck's cells follow this view when it is their lead (§25.3);
      // by every road the window moves, a link included, which is why it is
      // not the locus report above.
      onWindowChange: () => this.deck.grid?.leadMoved(),
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
    this.showStructureAlone()
  }

  /**
   * A structure that opened this session on its own: its model in a cell, and
   * nothing else on screen (§25.3).
   *
   * The file names sequences — its beads are on them — so the session is a
   * browser of that genome, and the browser had nothing to draw: a structure
   * is a row of the Structures card and a cell of the deck, never a lane. A
   * reader who dropped one bed3d on an empty window was shown an empty axis,
   * and the model only where they thought to look for it; the watch on the
   * store that opens a cell for every model that arrives had noted this one as
   * already there, since it came in with the store, before any deck could.
   *
   * So once the browser is mounted — the first moment a deck can frame it —
   * each model gets its cell, and the tracks give them the screen: **hidden,
   * not closed** (§16.9). The heading above the deck still steers which
   * stretch of the model is lit, and the deck's bar puts the tracks back. Left
   * on screen where anything is already drawn on them, as a session this
   * genome's memory restored may have.
   */
  private showStructureAlone(): void {
    if (!this.structureAlone) return
    this.structureAlone = false
    const store = this.annotations?.store
    if (store === undefined || !this.deck.possible) return
    const models = store.entries.filter((entry) => entry.kind === 'structure')
    if (models.length === 0) return
    const deck = this.deck.ensure()
    for (const model of models) deck.showStructure(model.id)
    const drawn = store.entriesOn(LEAD_MAP).some((entry) => entry.kind !== 'structure' && entry.card !== 'overlay')
    if (!drawn) deck.hideLead()
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
    // An empty tab is filled by the road the landing page's drop zone takes
    // ({@link openFiles}): a map takes the seat, and anything else opens the
    // browser its genome makes. The seat below is a map's alone, so a bigWig
    // pressed in the Files column on an empty tab — whose `+` says it opens
    // there — reached `dropped` with no tracks to join and did nothing at all.
    // Not while a file is opening: that tab is not empty, only not yet full.
    if (this.file === null && this.assembly === null && this.opening === null) {
      await this.openFiles(files)
      return
    }
    const maps = files.filter(
      (file) => !looksLikeConfig(file.name) && this.routeOf(file.name) === 'map',
    )
    // The empty seat, where there is one. `this.file` and not `deck.possible`:
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
    // no deck for a second one to join ({@link SessionDeck.possible}). Opened
    // instead, as *this* session's map — the ordinary meaning of dropping a
    // cooler on a viewer that already has one.
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
    this.deck.ensure().add({ kind: 'local', uri: file.name }, { kind: 'local', file })
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
    const name = picked.name !== undefined && picked.name.trim() !== '' ? picked.name : undefined
    await this.addRemote(picked.uri, picked.source, placement, map, name)
    // A backend that addresses files by id rather than by name says what the
    // file is called (§24.9), and a store row says what a file *is* (§24.2);
    // a map is named with it the way a reader would name it by hand (§16.10),
    // and a track takes it as its label through `addRemote`.
    if (name !== undefined && routeOf(picked.uri) === 'map') {
      this.renameMap(picked.uri, name)
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
    /**
     * What to call the track this makes, where the caller knows better than
     * the URL's last segment does: a store row's own line (§24.2), or the
     * name a Drive folder gave a file addressed by id (§24.9). A map is not
     * named here — {@link addPicked} renames one through the map's own road.
     */
    label?: string,
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
    // A Drive address pasted here says only its id; Drive says the rest (§24.9).
    if (label === undefined) label = (await this.driveName(uri, source)) ?? undefined
    if (this.destroyed) return
    // …and a workspace whose address does not say so, by the name it was
    // given: a Drive file is addressed by an id and a Dropbox one by a
    // temporary link, so the folder that listed it is what knows it is a
    // `session.json`. By its address alone it was taken for a track.
    if (label !== undefined && looksLikeConfig(label)) {
      await this.openConfigUrl(path, label)
      return
    }
    // An empty tab takes the file's name as its own: a tab that read
    // `1pq7NDWo…` for a file the folder called `ATAC_rep2.bw` was the one
    // place in the application the name did not reach.
    const wasEmpty = this.file === null && this.assembly === null
    if (routeFor(uri, label) === 'map') {
      // Beside the map that is open, exactly as {@link addCompanion} puts a
      // dropped one, and on the same two conditions: there has to be a map to
      // put it beside, and it has to be one a deck can hold (§16.8). Failing
      // either, it fills the tab — which is the empty seat being taken rather
      // than a replacement.
      //
      // The whole `uri` and not its `path`: `::entries/rep1` names which map
      // inside a collection, and the deck splits the two itself.
      if (this.file !== null && !this.file.info.hasGenomes) {
        this.deck.ensure().add({ kind: 'remote', uri }, source)
        return
      }
      await this.open(uri, source, undefined, undefined, undefined, label)
      if (wasEmpty && label !== undefined && this.name === null) this.rename(label)
      return
    }
    // Everything else is a track on what is here, and a tab with nowhere to put
    // one yet answers exactly as it answers a dropped file: an empty one is
    // filled, and one whose file has not finished building its annotation
    // stores does nothing. Every file gets those stores, a metacool included
    // (§8.5). This must not open it instead: the promise of the button this
    // arrives from is that it will not throw the open file away.
    if (this.annotations === null) {
      if (wasEmpty) {
        await this.open(uri, source, undefined, undefined, undefined, label)
        // The file that opened the browser is its first track, seated by
        // `openGenome` under the name it was given; a track seated under the
        // URL by an earlier road is relabelled here, which is the one moment
        // both are known.
        if (label !== undefined) this.relabelTrack(path, label)
        if (label !== undefined && this.name === null) this.rename(label)
      }
      return
    }
    // The same two steps a dropped track takes in {@link dropped}, and they are
    // written out again rather than shared because the two differ in the one
    // line between them: a local track is created from a `File` and a remote one
    // from a URL. What follows — moving what `begin` just made onto the map the
    // drop landed on — is the same, and is only reached when a drag said where.
    const held = this.annotations
    const before = new Set(held.store.entries.map((entry) => entry.id))
    held.loader.addUrl(path, label, placement)
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

  /** @internal SessionDeck routes a file dropped on a structure cell through it. */
  dropped(file: File, placement?: Placement, map?: string, index?: File): void {
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
    // No stores yet — nothing open, or a file still building them — so there is
    // nothing a dropped track could join. Every file gets them, a metacool
    // included (§8.5).
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
   * A structure arrived: open its cell beside the map (§25.3).
   *
   * Every road one arrives by — dropped, named by a URL, picked from a folder,
   * made by the Tracks card's own box or chooser, landed by a reconstruction —
   * ends in a row of the store, so it is watched there rather than hooked into
   * each road, and every road agrees: a structure row that was not there a
   * moment ago opens its cell. The moment the loader begins it where its name
   * says structure, so the cell is on screen while the file is read; once read
   * where only its bytes do. The drop and the URL roads used to open a cell by
   * the file's name as well, and between the two every dropped model was drawn
   * twice. The rows already in the list when the watch begins — a restored
   * session's — are noted and not opened, since their deck is the link's to
   * rebuild ({@link noteRestoredStructures}).
   */
  private watchStructureRows(store: AnnotationStore): void {
    const seen = this.knownStructures
    const now = store.entries.filter((entry) => entry.kind === 'structure')
    if (seen === null) {
      this.knownStructures = new Map(now.map((entry) => [entry.id, entry.payload]))
      return
    }
    // **Every** one that is new, not the last one noticed. Two models can
    // arrive in one turn of the store — a reader dropping two files together,
    // a batch of runs landing — and keeping only the last left the others as
    // rows on the card with no picture, which is the one state a reader reads
    // as *it did not work*.
    const fresh: string[] = []
    for (const entry of now) {
      const known = seen.has(entry.id)
      const held = seen.get(entry.id)
      // New, or the same id with a payload it did not have before: a row
      // that is still loading is noted and not shown until it can be.
      const replaced = known && entry.payload !== undefined && held !== undefined && held !== entry.payload
      seen.set(entry.id, entry.payload)
      if (known && !replaced) continue
      fresh.push(entry.id)
    }
    // …and each gets a cell of its own: a model that has just arrived — a file
    // dropped, a reconstruction landing — is the one the reader is waiting to
    // see, and it is drawn **beside** whatever was already there rather than
    // over it (§25.3). A run that wiped out the model it was to be compared
    // against was the commonest way to lose a picture in this app.
    if (fresh.length === 0 || !this.deck.possible) return
    const deck = this.deck.ensure()
    for (const id of fresh) deck.showStructure(id)
  }

  /**
   * Note the models a restore is about to bring back, before the first of
   * them lands (§25.3).
   *
   * The watch begins at the store's first change, and a restore lands one row
   * a change — so it used to note whichever rows were in by then and take every
   * model after them for a new arrival. Each opened a cell of its own on a deck
   * built for the purpose, and publishing that deck wrote its models into the
   * hash over the maps the link was about to put back: a workspace tab holding
   * five maps and five models came back as five models. Noted from storage, which
   * is what the restore reads, so a model the reader adds once the session is
   * open is still new.
   */
  private noteRestoredStructures(scope: string): void {
    this.knownStructures = new Map(
      AnnotationStore.stored(scope)
        .filter((row) => row.kind === 'structure')
        .map((row) => [row.id, undefined]),
    )
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
   * Genome card names it truthfully — "bigWig header" is a different claim from
   * "chrom.sizes", and both are different from the guess they replace.
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

  /**
   * The trail for a genome with no file behind it (§5.8).
   *
   * A browser reached by dropping a bigWig has no contact map, so there is no
   * `open()` to have built a breadcrumb: this is the one, and it is the same
   * component the map uses so the row does not change shape when the eye is
   * pressed. `rootKind` and `rootChoices` are the props a table needs and this
   * trail has no table — `Breadcrumb.pushBrowser` never reads them — so they
   * are the narrowest values that type-check rather than a second shape of
   * props for one caller.
   */
  private browserBreadcrumb(assembly: Assembly): Breadcrumb {
    return new Breadcrumb({
      rootKind: 'contigs',
      // The genome's own sequence list as well as the browser (§5.8): the
      // Chromosomes table is where a circle and an origin are declared, and a
      // genome browsed as tracks has both to declare with no map open (§8.15).
      rootChoices: ['contigs', 'whole'],
      contigNoun: 'Chromosomes',
      browser: true,
      fileLabel: assembly.name,
      entries: [],
      onNavigate: (state) => this.navigate(state),
      onOpenFile: () => this.host.openFileDialog(this),
    })
  }

  /** Whether the map behind this browser can be brought back. */
  get canShowMap(): boolean {
    return this.parkedMap !== null && this.file !== null
  }

  /**
   * Whether the map on screen can be put down without being unloaded.
   *
   * Three conditions, and each is a way the browser would come up empty rather
   * than a preference. A file whose annotation stores are not built yet has
   * nothing for a 1D browser to draw from; a file whose contigs have not been
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
   *
   * @internal SessionDeck builds a tracks cell's axis with it.
   */
  assemblyOfFile(file: OpenFile): Assembly | null {
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
   *
   * @internal SessionRouter puts the map down when a state asks for its tracks.
   */
  hideMap(): void {
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
   *
   * @internal SessionCommands runs the map key with it.
   */
  cycleView(): void {
    if (this.canShowMap) {
      // Coming back from the browser: the map, and only the map.
      this.mapOnly = true
      this.showMap()
      this.trackCard?.setMapOnly(true)
      return
    }
    if (this.mapOnly) {
      this.mapOnly = false
      this.current?.panel?.showLanes(true)
      this.trackCard?.setMapOnly(false)
      this.host.sessionChanged(this)
      return
    }
    this.hideMap()
  }

  /** The map view's Tracks card, kept so the map-only view can speak through it. */
  private trackCardFor(props: ConstructorParameters<typeof AnnotationCard>[0]): HTMLElement {
    const card = new AnnotationCard(props)
    card.setMapOnly(this.mapOnly)
    this.trackCard = card
    return card.el
  }

  /**
   * What a synthetic row on the Tracks card asks of the analysis workspace
   * (§18.5): its exports, and its task run again.
   *
   * Read through `this.analysis.workspace` at the moment of the press rather
   * than bound to a workspace here, because the Tracks card is built with the
   * file's store and the workspace a frame or two later, once a view has
   * mounted — and a change of resolution replaces the workspace under the same
   * card.
   */
  private syntheticRowHooks(): Pick<
    ConstructorParameters<typeof AnnotationCard>[0],
    'onExport' | 'onRecompute'
  > {
    return {
      onExport: (entry, format) => void this.analysis.workspace?.exportEntry(entry, format),
      onRecompute: (entry) => this.analysis.workspace?.recompute(entry),
    }
  }

  /**
   * The Structures card (§25): every model, loaded or computed, with the way
   * into the deck's cell and the way out as a bed3d.
   *
   * Under the Tracks card at each of the three places one is mounted, so a
   * model is found where a track is. A row's eye opens a cell of its own for
   * it, which is the same road a dropped g3d takes.
   */
  private structureCardFor(store: AnnotationStore, loader: AnnotationLoader): HTMLElement {
    this.structureCard?.destroy()
    const card = new StructureCard({
      store,
      loader,
      ...(this.deck.possible
        ? {
            onShow: (entry) => {
              if (!this.deck.possible) return
              this.deck.ensure().showStructure(entry.id)
              this.structureCard?.refresh()
            },
            // This row's own cell, not every one: each model has a cell of its
            // own (§25.3), so the eye on a row closes that row's picture and
            // leaves the others where they are.
            onHide: (entry) => {
              this.deck.grid?.hideStructure(entry.id)
              this.structureCard?.refresh()
            },
            shown: (id) => this.deck.grid?.shownStructures().includes(id) ?? false,
          }
        : {}),
      onRecompute: (entry) => this.analysis.workspace?.recompute(entry),
      // Read through `this.analysis.workspace` at the press, as `onRecompute`
      // is: a change of resolution replaces the workspace under the same card,
      // and carries its runs across to the new one.
      createdAt: (entry) => this.analysis.workspace?.createdAt(entry.id),
    })
    this.structureCard = card
    return card.el
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
   * **There is no map/tracks switch on the bars any more.**
   *
   * It was a button in six title bars whose face changed with the cycle's three
   * stops, and the eye in the Contact maps card already says the same thing in
   * the place a reader decides what is drawn: tick it and the map goes, untick
   * it and it comes back. Two controls for one act cost a slot on every bar in
   * the application and a second vocabulary for the state they shared.
   *
   * {@link cycleView} stays — the key still walks all three stops, and the
   * command list still lists it — because a key costs no room.
   */

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
      secondLabel: () =>
        this.compare.second === null ? undefined : this.mapLabel(this.compare.second.uri),
      onRename: (which, name) => {
        const target = which === 1 ? (this.file?.uri ?? uri) : this.compare.second?.uri
        if (target !== undefined) this.renameMap(target, name)
      },
      hasPrimary: () => this.file !== null,
      onOpen: (source) => {
        // With a map already open this is the *second* file, which is a
        // comparison.
        if (this.file !== null) {
          void this.compare.open(
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
      // A row out of the Files panel (§20.5): the same two seats. The second
      // file keeps the source the folder handed over — a bucket's credential, a
      // Drive file's name — where a dropped `File` has only its own.
      onPickDropped: (event) => {
        void readFileDrag(event).then((picked) => {
          if (picked === null || this.destroyed) return
          if (this.file === null) {
            void this.addPicked(picked)
            return
          }
          const name = picked.name !== undefined && picked.name.trim() !== '' ? picked.name : undefined
          void this.compare.open(picked.uri, picked.source).then(() => {
            const second = this.compare.second
            if (name !== undefined && second !== null) this.renameMap(second.uri, name)
          })
        })
      },
      // With one map open the × is the way out of the matrix altogether — the
      // door `closeMap` opens, which the File card used to carry. With two it
      // means what it has always meant: put this one down and keep the other.
      onClose: (which) => {
        if (which === 1 && this.compare.second === null) this.closeMap()
        else this.compare.close(which)
      },
      onToggleShown: (which) => {
        if (which === 1) this.toggleLeadShown()
        else {
          this.compare.hidden = !this.compare.hidden
          this.syncCompareCard()
          this.remount()
        }
      },
      isShown: (which) =>
        which === 1 ? this.parkedMap === null && this.deck.grid?.leadShown !== false : !this.compare.hidden,
      primaryInDeck: () => this.leadCellInDeck(),
      onSwap: () => void this.compare.swap(),
      // Every map this session is holding is a row here (§16.9): the deck's
      // other cells after the square's one or two, each with the grip that
      // drags it into another cell.
      deckMaps: () => [
        ...(this.deck.grid?.companionMaps() ?? []),
        ...this.deck.hidden.map(({ id, picked }) => ({
          id,
          uri: picked.uri,
          label: this.mapLabel(picked.uri),
          shown: false,
        })),
      ],
      onToggleDeckMap: (id) => this.deck.toggleMap(id),
      deckMapsShowable: () => this.deck.possible,
      onCloseDeckMap: (id) => {
        if (this.deck.takeHidden(id) !== null) this.syncCompareCard()
        else this.deck.grid?.closeCell(id)
      },
      onRenameDeckMap: (target, name) => this.renameMap(target, name),
      onDragMap: (dragging) => this.deck.grid?.showTiling(dragging),
      // The rows follow the grid, the first map's where its cell stands, and a
      // row dragged up or down the card moves its cell (§16.9).
      leadAt: () => this.deck.grid?.leadMapIndex ?? 0,
      onReorderMap: (map, onto, after) =>
        this.deck.grid?.moveMap(map === LEAD_ROW ? LEAD_MAP : map, onto === LEAD_ROW ? LEAD_MAP : onto, after),
    })
  }

  /**
   * Redraw the Contact maps card's eyes from what this session is showing.
   *
   * @internal SessionDeck redraws the card when the deck's maps change, and
   * SessionRouter when the map comes back.
   */
  syncCompareCard(): void {
    this.compareCard?.sync()
    // Every change that card follows — a map in or out of the deck, a map
    // renamed, the first map hidden — is one the File card's line can name.
    this.syncFileCard()
  }

  /**
   * The General column's File card follows the star (§16.5): the starred
   * companion's file, once its panel has opened it, and the session's own file
   * while the star is on the first map or on no map — named under the heading
   * whenever a deck is up, as the Aesthetics column's *Map* card is.
   *
   * @internal SessionDeck redraws it when the star moves.
   */
  syncFileCard(): void {
    const panel = this.infoPanel
    if (panel === null) return
    const deck = this.deck.grid
    if (deck === null || deck.isEmpty || this.file === null) {
      panel.setShown(null)
      return
    }
    const companion = deck.starredPanel
    if (companion !== null) {
      panel.setShown({ kind: 'other', name: this.mapLabel(companion.uri), info: companion.openInfo })
      return
    }
    panel.setShown({ kind: 'own', name: this.mapLabel(this.file.uri), starred: deck.starredMap === LEAD_MAP })
  }

  /** The map's eye, in the card that lists it: hide it, or bring it back. */
  private toggleMap(): void {
    if (this.canShowMap) this.showMap()
    else this.hideMap()
  }

  /**
   * The first map's eye: its **cell's**, in a deck with other cells (§16.9),
   * as every other map's eye is — and the 1D browser on its own, as it has
   * always been.
   *
   * In a deck the old meaning was a trap. Putting the map down for the browser
   * re-reads the state with no map to lead, and a deck of maps cannot stand
   * beside a browser (§25.3): the companions went with it. Hiding the
   * cell keeps every map where it is and the session on its file.
   */
  private toggleLeadShown(): void {
    const deck = this.deck.grid
    if (deck !== null && (!deck.leadShown || this.leadCellInDeck())) {
      if (deck.leadShown) deck.hideLead()
      else deck.showLead()
      return
    }
    this.toggleMap()
  }

  /** Whether the first map stands in a deck beside other cells, where its eye is its cell's. */
  private leadCellInDeck(): boolean {
    const deck = this.deck.grid
    return deck !== null && !deck.isEmpty && this.parkedMap === null && this.deck.possible
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
      // Declared on the genome's own Chromosomes table (§5.8, §8.15).
      this.circularColumn() ?? undefined,
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
   *
   * **Which mode it is comes from this session, not from `state.view`.** The two
   * can disagree: a link naming `view=region` on a file that could not be
   * opened leaves the map's view in the store while a browser over the
   * remembered genome is what got mounted, and the card then drew a 1 kb block
   * "on the diagonal" — contact-map words, on a screen with no contact map, a
   * kilobase into a sequence the browser was not showing. `this.file === null`
   * is the honest test for "there is no map here", and it is the one the card's
   * own question — *where am I* — has to be answered from.
   *
   * @internal SessionRouter calls it after every mount; the DOM tests replace
   * it on the instance.
   */
  syncMinimap(state: ViewState | null): void {
    const card = this.minimap
    if (card === undefined || card === null) return
    const assembly = this.assembly ?? (this.file === null ? null : this.assemblyOfFile(this.file))
    if (state === null || assembly === null) {
      card.update(null)
      return
    }
    if (state.view === 'browser' || this.file === null) {
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
    this.compare.release()
    this.compareCard = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    this.file = null
    this.breadcrumb = null
    this.breadcrumbHost.replaceChildren()
    this.reader?.terminate()
    this.reader = null
    this.assembly = assembly
    // The file's trail went with the file; the genome's takes its place, so the
    // row does not disappear when the map does.
    this.breadcrumb = this.browserBreadcrumb(assembly)
    // The cooler's own, because that is where these lengths came from: a task
    // run after the map is closed is still a measurement of that file, and its
    // record should say so rather than naming a genome with no file behind it.
    this.assemblySource = file.source
    if (held === null) this.setUpBrowserAnnotations(assembly)
    else {
      this.compareCard = this.newCompareCard(assembly.uri)
      // The marks, which this column used to leave out: the map's carried them
      // and a browser opened fresh does (`setUpBrowserAnnotations`), so closing
      // the map was the one road to a genome browser whose store held marks
      // with no card to see, place or remove one by. The map's own card where
      // there is one — the same store, and a picker that re-words its buttons
      // for the tracks on the render below — as hiding the map keeps it.
      this.manualCard ??= new ManualCard({
        store: held.manual,
        picker: this.markPicker(),
        fileLabel: fileLabel(assembly.uri),
      })
      this.setAnnotations([
        this.compareCard.el,
        new AnnotationCard({
          store: held.store,
          loader: held.loader,
          context: 'browser',
          onPickDropped: (event) => this.pickDropped(event),
          ...this.syntheticRowHooks(),
        }).el,
        this.structureCardFor(held.store, held.loader),
        this.manualCard.el,
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
    this.structureAlone = false
    // A genome browser replacing a map is a change of subject, whatever the two
    // files are called: nothing here is coming back at another bin size, so the
    // carry is spent before the drop rather than kept for an open that will
    // never happen.
    this.compare.carried = null
    this.annotations?.client.destroy()
    this.annotations = null
    this.knownStructures = null
    this.manualCard = null
    this.metadataCard = null
    this.bookmarksCard = null
    this.compare.drop()
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
    this.metaScope = null
    this.metaSelection = null
    this.contigOwners = null
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
   * **Every file gets them**, a metacool included — the store, the worker, the
   * loader and the cards (§8.5). There used to be a gate here: a file with a
   * genome layer got nothing, on the argument that its axis is contigs from
   * thousands of independently assembled organisms, so a track keyed on contig
   * names either coincides or misleads. A metagenome is one co-assembly binned
   * afterwards, so its names are one namespace, and what it needed instead was
   * an honest report of which MAGs a track covers — the `genome` the loader is
   * handed below. Only the Contact maps card stays off a metacool.
   */
  private async setUpAnnotations(uri: string, info: OpenResult): Promise<void> {
    this.annotations?.client.destroy()
    this.annotations = null
    this.knownStructures = null
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
    this.compare.drop()
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
    store.subscribe(() => {
      this.host.sessionChanged(this)
      this.watchStructureRows(store)
    })
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
    // A new store means the workspace that was watching the old one is stale:
    // it subscribes to the store it was *built* with, while `adopt` writes
    // through `host.store()` to whichever is current — so a workspace that
    // outlived its store would hold the numbers for rows the Tracks card no
    // longer lists, and export nothing when one of them asked. Destroyed here
    // rather than reconciled: a workspace is per-file, and so is a store.
    this.analysis.drop()
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
    this.bookmarkStore = new BookmarkStore(scope)
    this.bookmarksCard = new BookmarksCard({
      store: this.bookmarkStore,
      go: (mark) => this.goToBookmark(mark),
      available: () => this.current?.panel !== undefined,
      // Read off whatever panel is mounted *now*, not off one captured here: this
      // card is built once per file and the picture under it is rebuilt on every
      // navigation, so a held reference would save the window of a view the reader
      // left ten clicks ago.
      // In the file's coordinates, through whatever edit the map is drawn
      // through, so a later edit does not move it (§27.7).
      framed: () => {
        const framed = this.current?.panel?.framedRegion() ?? null
        if (framed === null || this.lens === null) return framed
        const kept = windowInFile(this.lens.assembly, framed)
        return kept === null ? null : { ...kept, ...(framed.wrapped === undefined ? {} : { wrapped: framed.wrapped }) }
      },
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
    // See the browser path: asked for, or merely brought along.
    const wanted = published.length > 0 && shelfWasAsked(uri)
    // Contact maps first, and that is the change of mind this card's eyes made
    // necessary: while it was only "load a second file to compare against" it
    // belonged under the tracks, as the rarest thing in the column. It is now
    // where a reader goes to *leave* the matrix, which is not a rare thing at
    // all — and a control that turns the whole picture into a genome browser
    // does not belong under eight track rows and a list of hand-drawn marks.
    // The file's own columns (§8.12). It goes **under the marks**, folded, with
    // the Bookmarks card after it: the column opens on what a reader loaded and
    // drew, and a column of the open map's own tables is reached for on purpose
    // rather than scanned past on the way to a track.
    this.metadataCard = new MetadataCard({
      store,
      index: () => this.annotations?.metadata ?? null,
      level: () => this.metadataLevel(),
      maps: () => this.deck.grid?.mapList ?? [{ id: LEAD_MAP, label: this.mapLabel(this.file?.uri ?? '') }],
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
      this.trackCardFor({
        store,
        loader,
        onPickDropped: (event) => this.pickDropped(event),
        ...this.syntheticRowHooks(),
        // Every map a track could be drawn on. A session with no deck answers
        // with itself, so the location control keeps the shape it has always
        // had until there is more than one map to choose between.
        maps: () => this.deck.grid?.mapList ?? [{ id: LEAD_MAP, label: this.mapLabel(this.file?.uri ?? '') }],
        ...(published.length === 0 || wanted
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
      }),
      this.structureCardFor(store, loader),
      this.manualCard.el,
      this.metadataCard.el,
      // Last, folded: a mark says *look here* on the picture you have and a
      // bookmark says *take me back* to a picture you had, and the second is
      // the one a reader opens when they have somewhere to keep (§8.10).
      this.bookmarksCard.el,
    ])

    // What a previous visit to this file left in session storage (§8.6). After
    // the cards are mounted, so the restored rows land in a list that exists —
    // seated now, and read once the map has drawn its first block, so the map
    // does not share its first read with every track download (`holdUntil`).
    loader.holdUntil(this.firstPicture())
    // …and where they were *drawn*, when the answer is not "on the lead".
    // Seeded rather than placed: the lanes go into the store's parking, and
    // `adoptHome` — which already runs once per render for every live cell —
    // puts each one back the moment a panel opens the file it belongs to. So a
    // companion that comes back gets its tracks, and one that does not leaves
    // them on the lead, which is exactly what closing a cell has always done.
    // `AnnotationStore.restore` is the order the two must be read back in.
    this.noteRestoredStructures(scope)
    AnnotationStore.restore(store, scope, (rows) => loader.restore(rows))
    // The tracks the reader asked for, put on. After the cards are mounted and
    // after `restore`, for `restore`'s own reason: a row landing in a list that
    // does not exist yet is a row nobody draws, and a row landing *before* the
    // restored ones would reorder a lane stack the reader arranged last time.
    if (wanted) {
      for (const entry of published) loader.addUrl(entry.url, entry.label)
    }
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
   *
   * @internal SessionAnalysis hands these to the first workspace built after
   * the switch.
   */
  carriedAnalysis: readonly CarriedResult[] | null = null

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
   * **Readable includes still reading.** A row whose bytes are on their way has
   * an address to read them from as surely as one that has them, and it was
   * left behind: a workspace seats its tracks reading, a row is remembered only
   * once it has loaded (§8.6), and the old file's worker is put down under it —
   * so a reader who picked another resolution in the second or two after a
   * store's session opened lost every one of its tracks, at the new rung and for
   * good. Carried, such a row is read again at the rung it arrives at.
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
    const rows = this.annotations?.store.entries.filter(
      (entry) => entry.status === 'ready' || entry.status === 'loading',
    )
    this.carried = rows === undefined || rows.length === 0 ? null : [...rows]
    const lanes = this.annotations?.store.placements
    this.carriedLanes = lanes === undefined || lanes.length === 0 ? null : [...lanes]
    const computed = this.reopeningSameFile(next) ? (this.analysis.workspace?.carry() ?? []) : []
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
   *
   * @internal SessionCompare carries the second file on the same test.
   */
  reopeningSameFile(next: string): boolean {
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
   *
   * @internal SessionAnalysis applies the snapshot again once its workspace has
   * added its rows.
   */
  adoptCarriedLanes(): void {
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
   *
   * @internal SessionCompare remembers a local second file under it, and
   * SessionDeck the deck's local companions.
   */
  memoryKey(uri: string): string {
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


  /**
   * @internal SessionDeck hands the declared circles to the companions, and
   * SessionAnalysis to every task.
   */
  circularStore(): CircularStore | null {
    const key = this.sessionKey()
    if (key === null) return null
    if (this.circularHeld?.key !== key) this.circularHeld = { key, store: new CircularStore(key) }
    return this.circularHeld.store
  }

  /**
   * The declared replication origins for the file on screen, held and keyed
   * exactly as the circular declarations are and for the same reason: a fact
   * about the file's molecules, the same at every rung (§8.15).
   */
  private originsHeld: { key: string; store: OriginStore } | null = null

  /** @internal SessionAnalysis hands the declared origins to every task. */
  originStore(): OriginStore | null {
    const key = this.sessionKey()
    if (key === null) return null
    if (this.originsHeld?.key !== key) this.originsHeld = { key, store: new OriginStore(key) }
    return this.originsHeld.store
  }

  /**
   * The edit of the file's reference (§27.2), held and keyed as the circular
   * declarations are — a fact about the file's sequences, the same at every
   * rung. Built once the contigs table is read, since an edit is checked
   * against the names and lengths it was made on. A dev feature (§29): `null`
   * while the switch is off, and the record is left as it was.
   */
  private editHeld: { key: string; store: EditStore } | null = null

  /**
   * @param genome On a metagenome, the genome whose edit it is (§27.10): its
   *   contigs alone, kept apart from every other genome's.
   */
  private editStore(genome?: string): EditStore | null {
    if (!devFeature('edit')) return null
    const base = this.sessionKey()
    const contigs = this.file?.contigs ?? null
    if (base === null || contigs === null) return null
    const key = genome === undefined ? base : genomeEditKey(base, genome)
    if (this.editHeld?.key !== key) {
      // The file's own sequences — which, where the session is drawn through an
      // edit, are the ones the edit was made on rather than the ones the
      // reader now answers with (§27.7).
      const pairs = contigPairs(contigs)
      const file = { names: pairs.map(([name]) => name), lengths: pairs.map(([, length]) => length) }
      const rows = genome === undefined ? [] : this.fileContigRowsOf(genome)
      const original =
        genome === undefined ? (this.lens?.edit.original ?? file) : { names: rows.map((row) => row.name), lengths: rows.map((row) => row.length), genome }
      const store = new EditStore(key, original, undefined, file)
      store.subscribe(() => this.referenceChip?.sync())
      this.editHeld = { key, store }
    }
    return this.editHeld.store
  }

  /**
   * The genome of a metagenome the reader is looking at, where one is in view.
   *
   * @internal SessionCommands names the genome the stage would edit.
   */
  genomeInView(): string | undefined {
    const scope = this.metaScope
    return scope?.kind === 'contigs' ? scope.genome : undefined
  }

  /**
   * The contig → MAG table of the metagenome (§27.10): every contig with the
   * genome the file puts it in, then every genome's kept edit applied.
   */
  private binning(): BinningTable {
    const base = this.sessionKey()
    const genomeNames = this.file?.genomes.table.data['name']
    const table = this.file?.contigs?.table
    const names = table?.data['name']
    const ids = table?.data['genome_id']
    const contigs: Array<{ name: string; genome: string }> = []
    if (Array.isArray(names) && Array.isArray(genomeNames) && ids !== undefined && !Array.isArray(ids)) {
      ;(names as string[]).forEach((name, row) => contigs.push({ name, genome: (genomeNames as string[])[Number(ids[row])] ?? UNBINNED }))
    }
    const edits = new Map<string, ReferenceEdit>()
    if (base !== null) {
      for (const genome of new Set(contigs.map((contig) => contig.genome))) {
        const edit = readEdit(recall<unknown>(genomeEditKey(base, genome), EDIT_SCOPE))
        if (edit !== null) edits.set(genome, edit)
      }
    }
    return binningTable(contigs, edits)
  }

  /** The genomes the stage may edit, as the picker lists them (§27.10). */
  private pickableGenomes(): PickableGenome[] {
    const base = this.sessionKey()
    return this.genomeRows().map(({ name, length }) => ({
      name,
      length,
      contigs: this.contigRowsOf(name).length,
      steps: base === null ? 0 : (readEdit(recall<unknown>(genomeEditKey(base, name), EDIT_SCOPE))?.cursor ?? 0),
    }))
  }

  /**
   * The edit the reader's map is drawn through (§27.7), as the reader accepted
   * it when the file opened; `null` for the file as it is. The edit store may
   * run ahead of it while the stage is open: the session is redrawn through the
   * store's when the stage closes ({@link redrawThroughEdit}).
   *
   * @internal SessionAnalysis runs a task through the edit the map is drawn
   * through.
   */
  lens: { edit: ReferenceEdit; assembly: EditedAssembly } | null = null

  /** The edit to open a file through: the one kept for it, where the dev features are on and it has a step. */
  private editToOpen(uri: string): ReferenceEdit | undefined {
    if (!devFeature('edit')) return undefined
    const stored = readEdit(recall<unknown>(this.memoryKey(uri), EDIT_SCOPE))
    return stored === null || stored.cursor === 0 ? undefined : stored
  }

  /**
   * Draw the session through the edit as it now stands, where the stage has
   * changed it (§27.7): the file opened again through it — as a change of
   * resolution opens it again — with the view carried to where its place went.
   */
  private async redrawThroughEdit(): Promise<void> {
    const file = this.file
    const state = this.store.state
    if (file === null || state === null || !devFeature('edit')) return
    const next = this.editToOpen(file.uri)
    const before = this.lens?.assembly ?? null
    const after = next === undefined ? null : EditedAssembly.of(next)
    if ((before === null && (after === null || after.isIdentity)) || (before !== null && after !== null && sameSteps(this.lens?.edit, next))) {
      return
    }
    const drawn = after === null || after.isIdentity ? null : after
    const carried = this.carryAcrossEntries(file.uri)
    if (carried === undefined) return
    const move = (region: string | undefined): string | null | undefined =>
      region === undefined ? undefined : carryRegion(region, before, drawn)
    const region = move(carried.region)
    const region2 = move(carried.region2)
    const focus = move(carried.focus)
    const lost = region === null || region2 === null
    const view: ViewState = lost
      ? { ...carried, view: 'contigs', region: undefined, region2: undefined, focus: undefined, regions: undefined }
      : {
          ...carried,
          ...(region === undefined ? {} : { region }),
          ...(region2 === undefined ? {} : { region2 }),
          ...(focus === undefined ? {} : focus === null ? { focus: undefined } : { focus }),
          // A selection names sequences, and an edit renames them: the table,
          // where the reader chose them, is where to choose them again.
          ...(carried.view === 'selection' ? { view: 'contigs' as const, regions: undefined } : {}),
        }
    await this.open(file.uri, file.source, view)
  }

  /**
   * A framing of the session's own map with the edit it is drawn through
   * (§27.7), so a result carries the assembly it was computed on and the next
   * edit makes it stale; a companion's, and the file as it is, unchanged.
   *
   * @internal SessionAnalysis frames every task through it.
   */
  withEditOf(framing: AnalysisFraming | null): AnalysisFraming | null {
    if (framing === null || this.lens === null || framing.uri !== this.file?.uri) return framing
    return { ...framing, edit: editFingerprint(this.lens.edit) }
  }

  /** Steps applied to the file's reference — from the store, or from the record it will read. */
  private editSteps(): number {
    if (this.editHeld !== null && this.editHeld.key === this.sessionKey()) return this.editHeld.store.applied
    const key = this.sessionKey()
    if (key === null) return 0
    return readEdit(recall<unknown>(key, EDIT_SCOPE))?.cursor ?? 0
  }

  /** The heading's word on the reference, with its questions answered by this session. */
  private referenceChip: ReferenceChip | null = null

  private referenceChipFor(): ReferenceChip {
    this.referenceChip = new ReferenceChip({
      steps: () => this.editSteps(),
      onOpen: () => void this.openEditStage(),
      onRevert: () => void this.revertEdit(),
    })
    return this.referenceChip
  }

  /**
   * The stage, while it is open.
   *
   * @internal SessionCommands offers the stage only while none is open.
   */
  editStage: EditStage | null = null

  /**
   * Open the stage on the file's map (§27.3): one map and its tracks, never a
   * deck. On a metagenome, on one genome of it (§27.10) — `genome`, else the
   * one in view, else the one the reader picks.
   *
   * @internal SessionCommands opens the stage with it.
   */
  async openEditStage(genome?: string): Promise<void> {
    if (!devFeature('edit') || this.editStage !== null) return
    const file = this.file
    const reader = this.reader
    if (file === null || reader === null) return
    await this.contigs().catch(() => null)
    let scope: string | undefined
    if (this.isMetacool) {
      scope = genome ?? this.genomeInView() ?? (await pickGenome(this.mapLabel(file.uri), this.pickableGenomes())) ?? undefined
      if (scope === undefined) return
    }
    const store = this.editStore(scope)
    if (store === null || this.destroyed || this.editStage !== null || this.file !== file) return
    const state = this.store.state
    const balance = file.info.hasWeights && state?.balance !== false
    const lanes = this.annotationContext()
    // One genome's contigs, and any brought into it: the picture of them alone.
    const drawn = store.edit.original.genome === undefined ? undefined : [...store.edit.original.names]
    this.editStage = new EditStage({
      title: this.mapLabel(file.uri),
      memoryKey: () => this.sessionKey() ?? file.uri,
      store,
      // What the method weighs is kept by the reader, where the suggestions
      // are then counted, off the stage's thread (§27.12).
      readPicture: (onProgress, contigs, cells) => {
        const wanted = contigs ?? drawn
        return reader.cancellable<'picture'>(
          { kind: 'picture', balance, method: true, keep: true, ...(wanted === undefined ? {} : { contigs: wanted }), ...(cells === undefined ? {} : { cells }) },
          onProgress,
        )
      },
      suggest: (input) => reader.cancellable<'suggest'>({ kind: 'suggest', ...input }),
      // Zoomed past the picture, the window on screen read finer (§27.9).
      readWindow: (request) => reader.cancellable<'stageWindow'>({ kind: 'stageWindow', ...request }),
      // A suggestion's points placed again at the finer rungs (§27.5).
      refine: (request) => reader.cancellable<'refine'>({ kind: 'refine', ...request }),
      // The circles the reader declared, whose origin the stage may set (§27.4).
      circular: () => this.circularStore()?.list() ?? [],
      // The binning every genome's edit makes, as the edits stand (§27.10).
      ...(scope === undefined ? {} : { binning: () => this.binning() }),
      // Where a genome's contigs and the others belong (§27.10): read without
      // being asked where the file is a moment's pass.
      ...(scope === undefined
        ? {}
        : {
            genomeLinks: {
              read: (contigs: string[], onProgress: (done: number, total: number) => void) =>
                reader.cancellable<'genomeLinks'>({ kind: 'genomeLinks', contigs }, onProgress),
              auto: (numberOr(file.info.info['nnz']) ?? Number.POSITIVE_INFINITY) <= LINKS_AUTO_PIXELS,
            },
          }),
      liftContacts: (edit, onProgress) => reader.cancellable<'exportLifted'>({ kind: 'exportLifted', edit }, onProgress),
      colormap: state?.colormap ?? DEFAULT_UI_COLORMAP,
      ...(lanes === undefined
        ? {}
        : { lanes: { store: lanes.store, ...(lanes.map === undefined ? {} : { map: lanes.map }), manual: lanes.manual, client: lanes.client, groups: lanes.groups } }),
      onClose: () => {
        this.editStage = null
        this.referenceChip?.sync()
        this.host.sessionChanged(this)
        // A genome's edit is its own files; the session is not drawn through it.
        if (scope === undefined) void this.redrawThroughEdit()
      },
    })
    this.host.sessionChanged(this)
  }

  /** Every step undone, and kept to be redone (§27.3). */
  private async revertEdit(): Promise<void> {
    await this.contigs().catch(() => null)
    this.editStore()?.revert()
    this.referenceChip?.sync()
    await this.redrawThroughEdit()
  }

  /**
   * The origins as the Chromosomes table draws them, and takes a typed one.
   *
   * A typed origin is the reader's (`OriginStore.set`), which a later run of
   * Origin and terminus leaves alone; cleared, the sequence goes back to its
   * first base and the task may place one again.
   */
  private originColumn(): OriginColumn | null {
    const store = this.originStore()
    if (store === null) return null
    return {
      get: (name) => store.get(name),
      set: (name, at) => {
        store.set(name, at)
        // The arms on screen and `ori` are read from it — every map's.
        this.rederive()
        this.deck.grid?.redeclared()
      },
      subscribe: (listener) => store.subscribe(listener),
    }
  }

  /**
   * Where an Origin and terminus run put each origin, taken into the
   * declarations for every sequence the reader has not set one on — and said,
   * because it changes what every arm-reading task will read from next.
   *
   * @internal SessionAnalysis hands it the origins a run placed.
   */
  adoptOrigins(uri: string, found: Readonly<Record<string, number>>): void {
    const file = this.file
    if (file === null || file.uri !== uri) return
    const taken = this.originStore()?.fill(found) ?? []
    if (taken.length === 0) return
    this.say(
      `Origin set on ${taken.slice(0, 3).join(', ')}${taken.length > 3 ? ', …' : ''} — the arms ` +
        'are read from it from now on. It is on the Chromosomes table.',
      uri,
    )
    this.rederive()
    this.deck.grid?.redeclared()
  }

  /**
   * Take a genome's declarations for a map of it (§8.15).
   *
   * A circle ticked and an origin set while the genome was browsed as tracks are
   * facts about the molecules the map is of, so a map opened over the browser
   * takes them — for its sequences of the same names, and only where it has no
   * declaration of its own. The map's first open still measures its circles
   * ({@link detectCircular}), which only ever adds a tick, and an origin already
   * set on the map stands; a reader's origin stays the reader's, and a task's
   * stays one the task may move.
   */
  private carryDeclarations(fromKey: string): void {
    const toKey = this.sessionKey()
    if (toKey === null || toKey === fromKey) return
    const names = new Set(contigPairs(this.file?.contigs ?? null).map(([name]) => name))
    const known = (name: string): boolean => names.size === 0 || names.has(name)
    const circular = this.circularStore()
    const added: string[] = []
    if (circular !== null) {
      for (const name of new CircularStore(fromKey).list()) {
        if (!known(name) || circular.has(name)) continue
        circular.set(name, true)
        added.push(name)
      }
    }
    const origins = this.originStore()
    if (origins !== null) {
      const from = new OriginStore(fromKey)
      const found: Record<string, number> = {}
      for (const name of Object.keys(from.record())) {
        const held = from.get(name)
        if (held === undefined || !known(name) || origins.get(name) !== undefined) continue
        if (held.by === 'reader') origins.set(name, held.at)
        else found[name] = held.at
      }
      origins.fill(found)
    }
    for (const name of added) this.adoptCircular(name, true)
  }

  /**
   * Tick the sequences whose contacts say they are circles — once per file, on
   * its first open (§8.15).
   *
   * Three small reads per sequence: the diagonal at each end and the corner that
   * joins them, `junctionScore` over the three. Balanced where the file has
   * weights, so the ends' own coverage does not decide it. Only the longest
   * sequences are measured, and only those long enough for the test to mean
   * anything; a sequence it could not decide is left as it was. What it measured
   * is kept whatever it found, which is what stops it running a second time — so
   * a box the reader unticks stays unticked.
   */
  private async detectCircular(uri: string): Promise<void> {
    const file = this.file
    if (file === null || file.uri !== uri || file.info.hasGenomes) return
    // The store is the file the state names; measuring one file into another's
    // declarations is the one mistake here that outlives the tab.
    if (this.sessionKey() !== this.memoryKey(uri)) return
    const store = this.circularStore()
    if (store === null || store.evidence() !== null) return
    const binsize = file.info.binsize ?? 0
    if (!(binsize > 0)) return
    let contigs: ContigsResult
    try {
      contigs = await this.contigs()
    } catch {
      return
    }
    if (this.destroyed || this.file !== file) return
    // A draft assembly is thousands of contigs; the ones a declaration is about
    // are the chromosomes and plasmids, which are the longest.
    const pairs = contigPairs(contigs)
    const tested = junctionCandidates(pairs, binsize)
    const balance = file.info.hasWeights
    // Each sequence at the coarsest rung that still gives it a hundred bins
    // (`junctionRung`): the windows are six bins, so what a read costs is the
    // rung's index and weights, and on a large file opened at its finest rung
    // those were megabytes a read.
    const rungs =
      file.info.entryGroup === 'resolutions'
        ? file.info.entries.filter((name) => /^\d+$/.test(name)).map(Number)
        : []
    const lengths = new Map(pairs)
    const scores: Record<string, number> = {}
    const circular: string[] = []
    const alive = (): boolean => !this.destroyed && this.file === file
    try {
      const atOpen = (candidate: JunctionCandidate): ReturnType<typeof measureJunctions> =>
        measureJunctions(
          [candidate],
          async (rows, cols) =>
            (
              await this.clientOf().request<'matrix'>({ kind: 'matrix', rows, cols, balance, background: true })
            ).values,
          alive,
        )
      for (const listed of tested) {
        // Where the file itself puts the sequence: the reader's extent, which a
        // level that floors its part-bins does not share with the arithmetic
        // `junctionCandidates` places it by. A name the reader cannot resolve —
        // one with a colon in it reads as a locus — is passed over rather than
        // ending the check.
        const extent = await this.clientOf()
          .request<'range'>({ kind: 'range', range: listed.name })
          .then(
            (range) => range.extent,
            () => null,
          )
        if (!alive()) return
        const candidate = extent === null ? null : placeCandidate(listed, extent)
        if (candidate === null) continue
        const length = lengths.get(candidate.name) ?? 0
        const rung = junctionRung(length, binsize, rungs)
        const binsAtRung = Math.ceil(length / rung)
        let measured: Awaited<ReturnType<typeof measureJunctions>>
        try {
          measured =
            rung === binsize
              ? await atOpen(candidate)
              : await measureJunctions(
                  [{ name: candidate.name, from: 0, n: binsAtRung }],
                  junctionReaderAt(this.clientOf(), candidate, binsAtRung, binsize, rung, balance),
                  alive,
                )
        } catch (err) {
          // A coarse rung that could not be read as the test reads it is asked
          // again where the file was opened, so the saving never costs an answer.
          // An end the balancer dropped is *not* asked again: it is undecided at
          // every rung — the unassembled start of a mouse chromosome is three
          // megabases of nothing whichever grid it is on — and asking twice was
          // the check's whole cost over again for no answer.
          if (!(err instanceof JunctionRungMismatch)) throw err
          measured = await atOpen(candidate)
        }
        if (measured === null) return
        Object.assign(scores, measured.scores)
        circular.push(...measured.circular)
      }
    } catch {
      // A read that failed is a file this test cannot be run on, which is no
      // reason to disturb the one being looked at. Nothing is recorded, so the
      // next open tries again.
      return
    }
    store.detected(scores, circular)
    const added = circular.filter((name) => store.has(name))
    for (const name of added) this.adoptCircular(name, true)
    if (added.length > 0) {
      this.say(
        `${added.slice(0, 3).join(', ')}${added.length > 3 ? ', …' : ''} ` +
          `${added.length === 1 ? 'reads' : 'read'} as circular — the contacts across the ` +
          'junction are those of neighbours. Untick on the Chromosomes table if not.',
        uri,
      )
    }
  }

  /**
   * Resolutions the reader has added to this file's ladder (§3.4).
   *
   * Held and keyed exactly as the circular declarations above are, and for the
   * same reason: it is a fact about the *file* rather than about the rung that
   * happens to be open, so a reader who adds 10 kb while looking at the 2 kb
   * level still has it after stepping to 1 kb.
   */
  private resolutionsHeld: { key: string; store: ResolutionStore } | null = null

  private resolutionStore(): ResolutionStore | null {
    const key = this.sessionKey()
    if (key === null) return null
    if (this.resolutionsHeld?.key !== key) {
      this.resolutionsHeld = { key, store: new ResolutionStore(key) }
    }
    return this.resolutionsHeld.store
  }

  /**
   * The ladder as the picker draws it: the file's rungs and the reader's own.
   *
   * One list in bin-size order, each of the added ones carrying the arithmetic
   * that reaches it. Empty for a file with no ladder at all, which is every
   * plain `.cool` — and there the `+` is still offered, because a `.cool` has
   * exactly one rung and a whole number of its bins is as reachable as ever.
   */
  private ladderRungs(): Array<Rung & { derived?: DerivedRung }> {
    const rungs = rungsOf(this.file?.info.entries ?? [])
    // A plain `.cool` has no entries and one resolution: its own. The `+` is
    // offered there too — one rung is still a rung, and a whole number of its
    // bins is as reachable as a whole number of any other's.
    const binsize = this.file?.info.binsize ?? 0
    const own =
      rungs.length > 0 ? rungs : binsize > 0 ? [{ name: String(binsize), binsize }] : []
    return ladderWith(own, this.resolutionStore()?.list() ?? [])
  }

  /**
   * The rung one step coarser (`1`) or finer (`-1`) than the one on screen, or
   * `null` (§3.4).
   *
   * The bar's own ladder, read from where the bar says it stands
   * (`rungStandingAt`), so a key steps from the stop that is lit and never from
   * somewhere the reader is not. `null` on a view with no bar to step — the
   * browser — at either end, and on a ladder of one.
   *
   * @internal SessionCommands enables the resolution keys by it.
   */
  rungStep(direction: 1 | -1): (Rung & { derived?: DerivedRung }) | null {
    const state = this.store.state
    const file = this.file
    if (state === null || file === null || state.view === 'browser') return null
    const rungs = this.ladderRungs()
    if (rungs.length < 2) return null
    return rungs[rungStandingAt(rungs, state.coarsen, file.currentEntry) + direction] ?? null
  }

  /**
   * `-` and `+`: stand on the next rung, by the road a press on its stop takes.
   *
   * @internal SessionCommands runs the resolution keys with it.
   */
  stepRung(direction: 1 | -1): void {
    const rung = this.rungStep(direction)
    if (rung === null) return
    if (rung.derived !== undefined) this.openDerived(rung.binsize)
    else this.openStoredRung(rung.name)
  }

  /**
   * The palette's line under each: the rung it goes to, or why there is none.
   *
   * @internal SessionCommands words the resolution keys by it.
   */
  rungHint(direction: 1 | -1): string | undefined {
    const rung = this.rungStep(direction)
    if (rung !== null) return resolutionLabel(rung.binsize) + (rung.derived === undefined ? '' : '*')
    if (this.file === null || this.store.state?.view === 'browser') return undefined
    // The `+` on the bar adds only coarser rungs — bins are added up, never
    // split — so it is the way on at the coarse end and at no other.
    if (direction < 0) return 'Already the finest resolution this file stores.'
    return this.ladderRungs().length < 2
      ? 'This file stores one resolution — the + beside it adds a coarser one.'
      : 'Already the coarsest — the + beside the resolution adds a coarser one.'
  }

  /**
   * The resolution the reader is looking at, where it is one they added.
   *
   * `null` on every ordinary view — the open rung's own bins — and on a state
   * whose `coarsen` this file cannot reach, which is what a link from somebody
   * with a different `.mcool` produces. Falling back to the file's own grid
   * rather than refusing is the rule every unreadable value in the hash follows.
   */
  private derivedRung(state: ViewState): DerivedRung | null {
    const asked = state.coarsen
    const binsize = this.file?.info.binsize ?? 0
    if (asked === undefined || !(binsize > 0) || asked <= binsize) return null
    if (asked % binsize !== 0) return null
    return { binsize: asked, from: { name: String(binsize), binsize }, factor: asked / binsize }
  }

  /**
   * The resolution the reader added that the session's map is drawn at, with
   * the grid its stored rung's bins are summed on — what an analysis of the map
   * is framed, priced and run at (§3.4, §18.4) — or `null` at a stored rung,
   * and before the sequence table the grid is laid out from has been read.
   *
   * From the table rather than from offsets, which the page does not hold: a
   * cooler lays each sequence out as `ceil(length / binsize)` bins, and the
   * check against the file's bin count is what says this one does.
   *
   * @internal SessionAnalysis frames every task on the lead through it.
   */
  analysisGrid(): DerivedGrid | null {
    const state = this.store.state
    const file = this.file
    if (state === null || file === null) return null
    const rung = this.derivedRung(state)
    if (rung === null) return null
    const lengths = file.contigs?.table.data['length']
    if (lengths === undefined || Array.isArray(lengths)) return null
    const fine = offsetsOf(lengths as ArrayLike<number>, rung.from.binsize)
    if (fine[fine.length - 1] !== file.info.nBins) return null
    return { rung, grid: CoarseGrid.of(fine, rung.factor) }
  }

  /**
   * `{ binsPerCell }` for a view of a declared resolution, else nothing.
   *
   * The factor rather than the bin size, because that is what a `matrix` request
   * takes and what the views hand to their ladders. Spread into every map view's
   * props so that one answer reaches the first read, the refine and the summary.
   */
  private pooledProps(state: ViewState): { binsPerCell?: number } {
    const derived = this.derivedRung(state)
    return derived === null ? {} : { binsPerCell: derived.factor }
  }

  /**
   * Stand on a resolution the reader added (§3.4).
   *
   * Two halves, and which of them runs depends on where the base rung is. A
   * derived rung is a whole number of some *stored* rung's bins, and the read
   * that produces it is an ordinary read of that rung with a plan on it — so
   * the file has to be open at it. Where it already is, this is a patch to the
   * hash and nothing is re-read that was not going to be; where it is not, the
   * file is re-opened at the base and the resolution rides along.
   *
   * A patch rather than a navigation, and not `replace`, for the reason the
   * level toggle is the same: stepping through resolutions is looking at one
   * thing several ways, and the back button should walk back through them.
   */
  private openDerived(binsize: number): void {
    const state = this.store.state
    if (state === null) return
    const rung = this.ladderRungs().find((each) => each.binsize === binsize)
    const derived = rung?.derived
    if (derived === undefined) return
    const open = this.file?.info.binsize ?? 0
    if (open === derived.from.binsize) {
      this.store.patch({ coarsen: binsize })
      return
    }
    const uri = this.file?.uri
    const source = this.file?.source
    if (uri === undefined || source === undefined) return
    const group = this.file?.info.entryGroup || 'entries'
    const next = `${splitUri(uri).path}::${group}/${derived.from.name}`
    const carried = this.carryAcrossEntries(next)
    void this.open(
      next,
      source,
      carried === undefined ? undefined : { ...carried, coarsen: binsize },
    )
  }

  /**
   * Stand on a rung the **file** carries.
   *
   * Two things have to happen and the second is the one that is easy to miss:
   * open the entry, *and* stop coarsening. A reader stepping from a derived
   * 3 kb to the file's own 2 kb has asked for 2 kb, and carrying the old
   * `coarsen` across would give them 6 kb under a stop marked 2 kb.
   *
   * On a plain `.cool` there is no entry to open — one rung, no `/resolutions`
   * group — so clearing it is the whole of the move, and trying to open
   * `file.cool::entries/1000` would be a read of something that does not exist.
   * The same shortcut serves the rung that is already open on a laddered file,
   * where re-opening it would be a needless round trip through the worker.
   */
  private openStoredRung(entry: string): void {
    const state = this.store.state
    if (state === null) return
    const uri = this.file?.uri
    const source = this.file?.source
    const entries = this.file?.info.entries ?? []
    if (uri === undefined || source === undefined) return
    // `/entries/rep1` in an mmetacool, `/resolutions/1000` in an mcool — the
    // same read the bar's own `currentEntry` is made with.
    const open = /^\/(?:entries|resolutions)\/(.+)$/.exec(splitUri(uri).group)?.[1]
    if (!entries.includes(entry) || entry === open) {
      if (state.coarsen !== undefined) this.store.patch({ coarsen: undefined })
      return
    }
    const next = `${splitUri(uri).path}::${this.file?.info.entryGroup || 'entries'}/${entry}`
    const carried = this.carryAcrossEntries(next)
    void this.open(
      next,
      source,
      carried === undefined ? undefined : { ...carried, coarsen: undefined },
    )
  }

  /** The `+`: ask for a resolution, add it, and stand on it. */
  private askResolution(): void {
    const store = this.resolutionStore()
    if (store === null) return
    const rungs = this.ladderRungs()
      .filter((rung) => rung.derived === undefined)
      .map(({ name, binsize }) => ({ name, binsize }))
    if (rungs.length === 0) return
    openResolutionDialog({
      rungs,
      declared: store.list(),
      // The file's own name, without the rung it happens to be open at: the
      // ladder belongs to the file, and `Ecoli.mcool::500 carries 500 bp, 1 kb,
      // …` reads as though the *entry* carried eight resolutions.
      fileLabel: this.file === null ? 'This file' : fileBaseLabel(this.file.uri),
      onConfirm: (derived) => {
        if (!store.add(derived.binsize)) return
        // Opened on it, because adding a resolution nobody is looking at is a
        // gesture with no visible result — and *look at this map at 10 kb* is
        // what the reader pressed `+` to do. The bar redraws as part of standing
        // on it, so the new stop appears with the picture rather than before it.
        this.openDerived(derived.binsize)
      },
    })
  }

  /**
   * Take a resolution back off the ladder.
   *
   * Standing on the one being removed is the case worth handling: the picture
   * has to come back to something, and the honest answer is the rung the file
   * *does* store — which is the one that is open, so dropping `coarsen` is the
   * whole of it.
   */
  private dropResolution(binsize: number): void {
    const store = this.resolutionStore()
    if (store === null) return
    store.remove(binsize)
    // Standing on the one being removed: the picture has to come back to
    // something, and the honest answer is the rung the file *does* store —
    // which is the one that is open, so dropping `coarsen` is the whole of it.
    // Otherwise only the bar changes, and redrawing it is cheaper than a
    // navigation that would re-read a block nobody asked to move.
    if (this.store.state?.coarsen === binsize) this.store.patch({ coarsen: undefined })
    else this.breadcrumb?.render(this.store.state)
  }

  /**
   * The declaration as the Chromosomes table takes it: read, write, watch.
   *
   * `null` before there is a file, which is the one state the table cannot be
   * mounted in anyway. The write goes through the session rather than straight
   * to the store so that a map already on screen adopts it — see
   * {@link adoptCircular} — and the watch is the store's own, because the same
   * fact is drawn in three places and none of them is the authority.
   */
  private circularColumn(): CircularColumn | null {
    const store = this.circularStore()
    if (store === null) return null
    return {
      has: (name) => store.has(name),
      set: (name, on) => {
        store.set(name, on)
        this.adoptCircular(name, on)
      },
      subscribe: (listener) => store.subscribe(listener),
      evidence: (name) => store.evidence()?.[name],
    }
  }

  /**
   * Let a map already on screen adopt a declaration made somewhere else.
   *
   * **Not a remount.** The declaration changes how the block is *read* — wrapped
   * or not, with a ceiling or a lap — so the ladder has to be built again; but a
   * remount would rebuild the view from its named region and throw away the
   * reader's zoom. The view re-arms its ladder against the block already on
   * screen instead.
   *
   * Guarded on the mounted view being a window on **this** sequence, because the
   * declaration is now made from a table that lists every one of them: telling a
   * region view of chrIV that chrI is circular would re-arm it with a wrap it
   * has no business having.
   */
  private adoptCircular(name: string, on: boolean): void {
    const state = this.store.state
    if (state === null || state.view !== 'region' || state.region === undefined) return
    if (state.region2 !== undefined) return
    const names = this.contigNames()
    if (names === null || contigOf(state.region, names) !== name) return
    this.current?.setCircular?.(on)
    // The arms are read round the circle or along the line (§8.15), and the
    // `ori` framing exists only on a circle: the map's presentation of both is
    // built from the declaration, so it is built again with it.
    this.rederive()
    // …and every companion's, which reads a window across the origin only where
    // the circle is declared.
    this.deck.grid?.redeclared()
  }

  /**
   * The circular declaration for a view that is a window on one sequence.
   *
   * `undefined` on every other view, and each exclusion is a question the
   * declaration could not answer honestly here: a two-contig block has no
   * diagonal to slide along, a whole-genome picture is a list of sequences of
   * which some may be circular and some not, and a name that is not a sequence
   * of this file is a genome or a typo (SPECS §8.15).
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
        this.adoptCircular(name, on)
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
   *
   * @internal SessionDeck renames a map from its panel's heading through it.
   */
  renameMap(uri: string, name: string | null): void {
    const key = this.sessionKey()
    if (key === null) return
    const held = this.mapNames()
    const next = withMapName(held, uri, name)
    if (mapNameIn(next, uri) === mapNameIn(held, uri)) return
    remember(key, MAP_NAMES_SCOPE, next)
    this.compareCard?.sync()
    this.deck.grid?.renamed()
    // The location rows name the maps too (§16.10: one name, everywhere).
    this.trackCard?.renamed()
    // Written into the mounted panel rather than through {@link remount}: a
    // rename changes what the picture is *called* and nothing about what is in
    // it, and rebuilding the view would put a gated whole-genome scan (§7.3)
    // back behind its button — the reader types a name and their map goes away.
    const own = this.file === null ? undefined : this.mapLabel(this.file.uri)
    if (own !== undefined) {
      this.current?.panel?.setMapLabels(
        own,
        this.compare.second === null ? undefined : this.mapLabel(this.compare.second.uri),
      )
    }
    // …and the Analysis drawer, whose tabs, overlay legends and all-maps tables
    // name each map by what it is called now: they are read off the targets on
    // every refresh, so a result computed before the rename follows it.
    this.analysis.workspace?.refresh()
  }

  // -------------------------------------------------------------------------
  // The deck of panels (§16)
  // -------------------------------------------------------------------------

  /**
   * Bring the companions in line with the hash — {@link SessionDeck.sync}.
   *
   * Kept on the session, and called through it by `render`, because it is a
   * seam: the DOM tests replace it on the instance to stand the deck aside
   * (`test/dom/render-cancellation.test.ts`) and call it to reconcile one
   * (`test/dom/deck-drop-many.test.ts`). A render that went to the deck
   * directly would step round both.
   *
   * @internal SessionRouter reconciles the deck through it.
   */
  syncDeck(state: ViewState): Promise<void> {
    return this.deck.sync(state)
  }

  // -------------------------------------------------------------------------
  // What a map is drawn with
  // -------------------------------------------------------------------------

  /**
   * The turn, as every panel of the session sees it.
   *
   * Deck-wide by construction: it is built from the state, and every panel is
   * handed the same state, so a flip is one key and N pictures. Which way each
   * one grows is the caller's — a lone map and the first file of a comparison
   * grow up, the second grows down so the pair meets at one axis.
   *
   * @internal SessionDeck shares the turn with every companion.
   */
  turnPresentation(state: ViewState, direction?: RotateDirection): TurnPresentation {
    return {
      // Absent is *off*: a map opens square, and the turn is the reading a reader
      // asks for. It used to be the other way round — see `ViewState.flip` for
      // the argument and for why it was wrong, which comes down to *which* maps
      // the default reached: `isTurnable` admits one sequence against itself and
      // nothing else, so the maps it turned were exactly the single chromosomes
      // a reader had just clicked on, and the picture changed shape as they
      // arrived.
      on: state.flip === true,
      ...(direction === undefined ? {} : { direction }),
      onChange: (on) => {
        // The turn is what gets written down; the square is the absence, which is
        // what keeps an ordinary view's hash short.
        this.store.patch({ flip: on ? true : undefined })
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
   * The circle (§7.6), as the view on screen is handed it — or `undefined`
   * where it is not offered at all: a file with no genome layer, or the dev
   * features off (§29.2).
   *
   * Offered on every map of a metagenome and greyed on the two that cannot be
   * drawn round, each with its reason, on the turn's rule: a reader on a pair
   * can see the control exists and learn what it wants of them.
   */
  private circleFor(state: ViewState): CirclePresentation | undefined {
    const refusal =
      state.view === 'pair'
        ? 'A pair of genomes is a rectangle with no diagonal to draw round; tick both in the Genomes table to see them as a circle.'
        : state.view === 'region'
          ? 'A window of one sequence has nothing to join; a circle is drawn of genomes, or of a genome’s contigs.'
          : undefined
    return this.circlePresentation(state, refusal)
  }

  private circlePresentation(state: ViewState, refusal?: string): CirclePresentation | undefined {
    if (!devFeature('circle')) return undefined
    const file = this.file
    if (file === null || !file.info.hasGenomes) return undefined
    const uri = state.uri
    return {
      // Absent is the square, as for the turn: the circle is what gets written
      // down, and only when the reader asks for it — and drawing it puts the
      // two lines away, which are the other picture of the same block.
      on: state.circle === true && state.lines !== true,
      onChange: (on) => {
        this.store.patch({ circle: on ? true : undefined, lines: undefined })
        this.rederive()
        // What the Metadata card offers is what the picture on screen can draw.
        this.metadataCard?.refresh()
      },
      lines: this.linesPresentation(state),
      // Its cut, where the block offers two: written down only when it is not
      // the genomes, as the circle itself is only when it is drawn.
      cut: state.sections === 'contigs' ? 'contigs' : 'genomes',
      onCut: (cut) => {
        this.store.patch({ sections: cut === 'contigs' ? 'contigs' : undefined })
        this.rederive()
      },
      ...(refusal === undefined ? {} : { refusal }),
      resolver: this.circleResolver(),
      // A section opens what it is, as an axis label of the square does: a
      // genome its own map — drawn round while the circle is on — and a contig
      // its window.
      onOpenUnit: (unit) => {
        if (unit.kind === 'genome') {
          this.navigate({ uri, view: 'genome', genome: unit.name })
          return
        }
        this.navigate({
          uri,
          view: 'region',
          region: unit.name,
          ...(unit.genome === undefined ? {} : { genome: unit.genome }),
        })
      },
      onOpenGroup: (genome) => this.navigate({ uri, view: 'genome', genome }),
      // An arc carried along the circle moves in the reader's order (§7.6),
      // which every map and list of the file follows; a genome of the band
      // over contig sections moves among the genomes.
      onMoveUnit: (moved, anchor, side) => this.moveUnit(state, moved, anchor, side),
      onMoveGroup: (moved, anchor, side) => this.moveGenomes([moved], anchor, side),
      // A chord opens the block between its two ends, as an off-diagonal cell
      // does: the pair view of two genomes, the window pair of two contigs.
      onOpenPair: (a, b) => {
        if (a.kind === 'genome') {
          this.navigate({ uri, view: 'pair', genome: a.name, genome2: b.name })
          return
        }
        this.navigate({
          uri,
          view: 'region',
          region: a.name,
          region2: b.name,
          ...(a.genome !== undefined && a.genome === b.genome ? { genome: a.genome } : {}),
        })
      },
    }
  }

  /**
   * The two lines (§7.6), as the view on screen is handed them: the genomes
   * split by a column of the Genomes table, offered wherever the circle is and
   * greyed, each with its reason, where they have no genomes to split — one
   * genome's contigs, which all have its value; a pair, which is a rectangle; a
   * window of one sequence — or where no column of the table holds two values.
   */
  private linesPresentation(state: ViewState): LinesPresentation {
    const file = this.file
    const choices = this.splitChoices()
    const split =
      file === null || state.split === undefined
        ? null
        : lineSplit(file.genomes.table, file.genomes.display, state.split, state.top)
    const why =
      state.view === 'genome'
        ? 'One genome’s contigs all have its value; the two lines split genomes — tick some in the Genomes table, or open the whole metagenome.'
        : state.view === 'pair'
          ? 'A pair of genomes is a rectangle; tick both in the Genomes table, with others, to split them over two lines.'
          : state.view === 'region'
            ? 'A window of one sequence has no genomes to split; the two lines are drawn of genomes, or of their contigs.'
            : choices.every((choice) => choice.levels === null)
              ? 'No column of the Genomes table holds two values to split the genomes by.'
              : undefined
    return {
      on: state.lines === true,
      onChange: (on) => {
        this.store.patch({ lines: on ? true : undefined, circle: undefined })
        this.rederive()
        this.metadataCard?.refresh()
      },
      ...(why === undefined ? {} : { refusal: why }),
      split,
      choices,
      // A new column starts with its first value on top.
      onColumn: (column) => {
        this.store.patch({ split: column, top: undefined })
        this.rederive()
      },
      onSwap: () => {
        if (split === null) return
        this.store.patch({ top: split.levels[1] })
        this.rederive()
      },
    }
  }

  /** Every column of the Genomes table as the two lines' `split by` offers it, once per table. */
  private splitChoices(): readonly SplitChoice[] {
    const genomes = this.file?.genomes ?? null
    if (genomes === null) return []
    if (this.splitChoicesMemo?.genomes !== genomes) {
      this.splitChoicesMemo = { genomes, choices: splitChoices(genomes.table, genomes.display) }
    }
    return this.splitChoicesMemo.choices
  }

  // -------------------------------------------------------------------------
  // The reader's order (§7.6)
  // -------------------------------------------------------------------------

  /**
   * The reader's order of the open file's genomes and contigs, kept per file
   * in session memory (`state/readerOrder.ts`) — `null` on a file with no
   * genomes, and where the circle, the one place it is set, is not offered.
   */
  private orderStore(): OrderStore | null {
    const file = this.file
    if (file === null || !file.info.hasGenomes || !devFeature('circle')) return null
    const key = this.memoryKey(file.uri)
    if (this.orderHeld?.key !== key) {
      this.orderHeld?.off()
      const store = new OrderStore(key)
      this.orderHeld = { key, store, off: store.subscribe(() => this.orderMoved()) }
    }
    return this.orderHeld.store
  }

  /**
   * What a map's panel draws its block in: the order now, told when it moves,
   * and the genome each axis is where the block does not say — one genome's
   * map, a pair's two.
   */
  private panelOrder(axes?: AxisGenomes): { order?: PanelOrder } {
    const store = this.orderStore()
    if (store === null) return {}
    return {
      order: {
        ranks: () => store.currentRanks,
        subscribe: (listener) => store.subscribe(listener),
        ...(axes === undefined ? {} : { axes }),
        moved: () => !isFileOrder(store.current),
        reset: () => this.resetOrder(),
      },
    }
  }

  /**
   * The genome each axis of a region view is: a region that names a genome is
   * that genome, and a window is in the genome it was opened from.
   */
  private regionAxes(state: ViewState): AxisGenomes | undefined {
    const names = this.file?.displayNames ?? []
    const rows = state.region !== undefined && names.includes(state.region) ? state.region : state.genome
    const cols =
      state.region2 === undefined ? rows : names.includes(state.region2) ? state.region2 : undefined
    if (rows === undefined && cols === undefined) return undefined
    return { ...(rows === undefined ? {} : { rows }), ...(cols === undefined ? {} : { cols }) }
  }

  /**
   * The order the lead's map is drawn in, for the deck's companions to draw
   * theirs in (§7.6), with the lead's axes: a companion follows the lead's view.
   *
   * @internal SessionDeck hands it to every map of the deck.
   */
  leadOrder(): PanelOrder | undefined {
    const state = this.store.state
    if (state === null) return undefined
    const axes =
      state.view === 'genome'
        ? { rows: state.genome, cols: state.genome }
        : state.view === 'pair'
          ? { rows: state.genome, cols: state.genome2 }
          : state.view === 'region'
            ? this.regionAxes(state)
            : undefined
    return this.panelOrder(axes).order
  }

  /** The file's genomes as the reader has them, `__unbinned__` left out. */
  private arrangedGenomes(): string[] {
    const file = this.file
    if (file === null) return []
    return arrange(file.displayNames, this.orderStore()?.current.genomes)
  }

  /**
   * Every contig of the file in the reader's order, as rows of the contigs
   * table: genome by genome as they are placed, and each genome's in its own —
   * the contigs of no genome after, as the file has them. Rows rather than
   * names, so two contigs of one name in two genomes each keep their own.
   * `null` before the table is read, and where the order is the file's.
   */
  private arrangedContigRowList(): number[] | null {
    const table = this.file?.contigs?.table
    const order = this.orderStore()?.current ?? FILE_ORDER
    if (table === undefined || isFileOrder(order)) return null
    const names = table.data['name']
    const memo = this.arrangedContigsMemo
    if (memo !== null && memo.names === names && memo.order === order) return memo.out
    const ids = table.data['genome_id']
    const genomeNames = this.file?.genomes.table.data['name']
    if (!Array.isArray(names) || ids === undefined || Array.isArray(ids) || !Array.isArray(genomeNames)) return null
    const byGenome = new Map<string, number[]>()
    for (let row = 0; row < names.length; row++) {
      const genome = (genomeNames as string[])[Number(ids[row])] ?? ''
      const rows = byGenome.get(genome)
      if (rows === undefined) byGenome.set(genome, [row])
      else rows.push(row)
    }
    const out: number[] = []
    for (const genome of this.arrangedGenomes()) {
      const rows = byGenome.get(genome)
      if (rows === undefined) continue
      byGenome.delete(genome)
      const placed = order.contigs[genome]
      if (placed === undefined) {
        out.push(...rows)
        continue
      }
      // Within one genome a name is one contig.
      const rowOf = new Map(rows.map((row) => [(names as string[])[row], row]))
      for (const name of arrange(rows.map((row) => (names as string[])[row]), placed)) {
        const row = rowOf.get(name)
        if (row !== undefined) out.push(row)
      }
    }
    for (const rows of byGenome.values()) out.push(...rows)
    this.arrangedContigsMemo = { names: names as string[], order, out }
    return out
  }

  /** Every contig's name in the reader's order — {@link arrangedContigRowList}'s, as names. */
  private arrangedContigNames(): string[] | null {
    const names = this.contigNames()
    const rows = this.arrangedContigRowList()
    return names === null || rows === null ? names : rows.map((row) => names[row])
  }

  /** The contigs table's rows in the reader's order, where it is not the file's. */
  private arrangedContigRows(data: { table: { data: Record<string, unknown> } }): { rows?: number[] } {
    const rows = this.arrangedContigRowList()
    const names = data.table.data['name']
    return rows !== null && Array.isArray(names) && rows.length === names.length ? { rows } : {}
  }

  /**
   * The order moved, from a drag on any map of the file: every map's panel
   * follows on its own subscription, and so does the card of genomes or
   * contigs; what the session keeps from them follows here — the steps `<` and
   * `>` take, and the order a tick on the card draws its genomes in.
   */
  private orderMoved(): void {
    this.stepCache = null
    if (this.metaScope !== null) this.metaOrder = this.metaRows(this.metaScope).map((row) => row.name)
  }

  /** Genomes put beside another (§7.6): what a drop on the circle, or on a line, does. */
  private moveGenomes(genomes: readonly string[], anchor: string, side: Side): void {
    const file = this.file
    const store = this.orderStore()
    if (file === null || store === null) return
    store.set(withGenomesMoved(store.current, file.displayNames, genomes, anchor, side))
  }

  /**
   * Contigs put beside another of their genome's (§7.6), never into another
   * genome — and nothing moved before the contigs table can say the genome's
   * contigs, which an order is kept against.
   */
  private moveContigs(genome: string, contigs: readonly string[], anchor: string, side: Side): void {
    const store = this.orderStore()
    if (store === null) return
    const file = this.fileContigRowsOf(genome).map((row) => row.name)
    const known = new Set(file)
    if (!known.has(anchor) || !contigs.every((name) => known.has(name))) return
    store.set(withContigsMoved(store.current, genome, file, contigs, anchor, side))
  }

  /**
   * An arc dropped beside another on the circle (§7.6): a genome — or a slot of
   * several, where the file has more genomes than the picture has cells — among
   * the genomes, and a contig, or every contig of a cell, among its genome's.
   * Before a neighbour is before the first of it in the reader's order, after it
   * after its last.
   */
  private moveUnit(state: ViewState, moved: CircleUnit, anchor: CircleUnit, side: Side): void {
    const beside = (names: readonly string[], order: readonly string[]): string | undefined => {
      const rank = new Map(order.map((name, i) => [name, i]))
      const ranked = [...names].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
      return side === 'before' ? ranked[0] : ranked[ranked.length - 1]
    }
    if (moved.kind === 'genome') {
      const to = beside(this.unitGenomes(anchor), this.arrangedGenomes())
      if (to !== undefined) this.moveGenomes(this.unitGenomes(moved), to, side)
      return
    }
    const genome = moved.genome ?? state.genome
    if (genome === undefined || (anchor.genome ?? genome) !== genome) return
    const contigsOf = (unit: CircleUnit): string[] =>
      unit.sequences.length > 0 ? unit.sequences.map((sequence) => sequence.name) : [unit.name]
    const to = beside(
      contigsOf(anchor),
      this.contigRowsOf(genome).map((row) => row.name),
    )
    if (to !== undefined) this.moveContigs(genome, contigsOf(moved), to, side)
  }

  /**
   * The genomes an arc of genomes is: its own, or a pooled slot's — the slot's
   * first and the ones after it in the file, which the worker pools in order.
   */
  private unitGenomes(unit: CircleUnit): string[] {
    const count = slotCount(unit.label)
    const names = this.file?.displayNames ?? []
    const from = count > 1 ? names.indexOf(unit.name) : -1
    return from < 0 ? [unit.name] : names.slice(from, from + count)
  }

  /** Every genome and contig back where the file has it. */
  private resetOrder(): void {
    this.orderStore()?.set(FILE_ORDER)
  }

  /**
   * The tables' answers about a circle's sections, asked afresh on every call.
   *
   * Live rather than captured: the presentation is built on a render, and the
   * contigs table it needs may land after that render — so each question goes
   * through to whatever the session holds now, and the first that finds the
   * table missing asks for it.
   */
  private circleResolver(): CircleResolver {
    const now = (): CircleResolver => {
      const file = this.file
      if (file === null) return {}
      const held = this.circleIndex
      if (held !== null && held.genomes === file.genomes && held.contigs === file.contigs) return held.resolver
      if (file.contigs === null) void this.awaitCircleContigs()
      const resolver = circleResolverFrom(
        file.genomes.table,
        file.genomes.display,
        file.contigs?.table ?? null,
        () => this.orderStore()?.current ?? null,
      )
      this.circleIndex = { genomes: file.genomes, contigs: file.contigs, resolver }
      return resolver
    }
    return {
      genomeLength: (genome) => now().genomeLength?.(genome),
      genomeSequences: (genome) => now().genomeSequences?.(genome) ?? null,
      slotSequences: (first, count) => now().slotSequences?.(first, count) ?? null,
      contigLength: (name) => now().contigLength?.(name),
    }
  }

  /** Read the contigs table for a circle that asked before it was read, then redraw. */
  private async awaitCircleContigs(): Promise<void> {
    if (this.circleContigsPending) return
    this.circleContigsPending = true
    try {
      await this.contigs()
    } catch {
      return
    } finally {
      this.circleContigsPending = false
    }
    if (this.destroyed) return
    this.current?.panel?.repaint()
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
   *
   * @internal SessionRouter calls it on a repaint; the DOM tests replace it on
   * the instance.
   */
  rederive(): void {
    const state = this.store.state
    if (state === null) return
    // The list first: a circle ticked or unticked on the sequence on screen
    // offers the baseline along its arms or takes it away (§8.15), and the
    // derivation below is of whichever score the state resolves to *now*.
    this.current?.panel?.offerScores(scoreChoices(this.scoreProps(state)), this.scoreOf(state).id)
    this.current?.panel?.rederive(
      this.derivePresentation(state),
      undefined,
      this.turnPresentation(state),
      this.circleFor(state),
    )
  }

  /**
   * Rebuild the mounted view for the state it is already in.
   *
   * The one thing a view cannot be told about after it is built is which blocks
   * it should have read, and both of the things that reach here — a second file
   * arriving or leaving, and the gain applied to it — change exactly that.
   * Clearing `mounted` is what makes the next render a navigation rather than a
   * repaint.
   *
   * @internal SessionCompare remounts when its second file lands or leaves.
   */
  remount(): void {
    const state = this.store.state
    if (state === null) return
    const restore = this.current?.panel?.borrowedFrom() ?? null
    this.carriedScale = restore === null ? null : { uri: state.uri, restore }
    this.mounted = null
    this.wholeFile?.view.destroy()
    this.wholeFile = null
    void this.render(state)
  }

  /**
   * The context a heatmap view hands to its panel, or `undefined`.
   *
   * @internal SessionDeck hands each companion its own.
   */
  annotationContext(map?: string): AnnotationContext | undefined {
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
          // The edit the session's own map is drawn through (§27.7), for its
          // lanes. The lead's alone: a companion is a file of its own, drawn
          // as it is until companions are drawn through the lens too.
          ...(map === undefined || map === LEAD_MAP ? { edited: () => this.lens?.assembly ?? null } : {}),
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
          // `null` is the middle of the map, *on this map* (§8.1): no edge is
          // named, so a track takes its usual one and an overlay the map's face.
          loadOnEdge: (files, edge) => {
            this.droppedAll(files, edge === null ? undefined : placementOn(edge), map)
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
              void this.addPicked(picked, edge === null ? undefined : placementOn(edge), map)
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
   *
   * @internal SessionDeck's *fix all resolutions* moves the first map through
   * it.
   */
  openAtBinsize(binsize: number): boolean {
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
   * Built here rather than in the view for the reason the Sequences card is:
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
      withKey('Bookmark this view — the place on screen, at this resolution', KEYS.bookmark),
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
    // Kept in the file's coordinates, it is set down wherever the edit the map
    // is drawn through puts it (§27.7); one taken before bookmarks were, in an
    // edited sequence's name, is gone to as it is.
    const kept = formatRegion(mark)
    const carried = this.lens === null || this.lens.assembly.sequence(mark.contig) !== null ? kept : carryRegion(kept, null, this.lens.assembly)
    if (carried === null) {
      this.bookmarksCard?.say(`${formatLocus(mark)} is set aside by the edit the map is drawn through.`)
      return
    }
    const where = /^(.*):\d+-\d+$/.exec(carried)?.[1] ?? carried
    this.navigate({
      uri: this.uriAtBinsize(mark.binsize) ?? state.uri,
      view: 'region',
      region: where,
      focus: carried,
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

  /**
   * The balance in force: the state's choice, else the file's default.
   *
   * @internal SessionRouter tells a repaint from a new read by it.
   */
  balanceOf(state: ViewState): boolean {
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
   *
   * @internal SessionRouter tells a repaint from a new read by it.
   */
  valueOf(state: ViewState): string | undefined {
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
   *
   * @internal SessionDeck shares the first map's score with the companions, and
   * SessionRouter points a repainted picker at it.
   */
  scoreOf(state: ViewState): ScoreChoice {
    const props = this.scoreProps(state)
    return scoreFor(scoreChoices(props), { ...props, balance: this.balanceOf(state) })
  }

  /**
   * What every map view needs to draw and drive the baseline toggle.
   *
   * Built here rather than in each view for the reason the score picker's props
   * are: four views mount the same panel, and a default decided four times is a
   * default that comes to differ in three of them.
   *
   * @internal SessionDeck shares it with every companion.
   */
  derivePresentation(state: ViewState): DerivePresentation {
    const normalise = this.normaliseOf(state)
    return {
      ...(normalise === undefined ? {} : { normalise }),
      expected: state.oe === true,
      onExpectedChange: (on) => {
        // Off takes the arms with it: they are which expectation the ratio is
        // taken against, and with no ratio they are a setting about nothing.
        this.store.patch({ oe: on ? true : undefined, ...(on ? {} : { arms: undefined }) })
        this.rederive()
      },
      ...this.armsOf(state),
      // From the score rather than from a key of its own: the correlation *is*
      // one of the answers to "what are these numbers", and it carries the
      // balancing and the baseline it needs with it (`ui/scores.ts`).
      correlate: this.scoreOf(state).correlate === true,
      // Also from the score, and for the same reason: "show me the denominator"
      // is an answer to what the cells are, not a second switch beside the one
      // that divides by it (`ui/scores.ts`).
      baseline: this.scoreOf(state).baseline === true,
      // …and so is taking it along a circle's two arms (§8.15).
      alongArms: this.scoreOf(state).alongArms === true,
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
        this.say(`Correlation failed: ${message}`)
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
   * The arm-frame O/E for a view that is a window on one sequence (§8.15).
   *
   * Nothing on any other view — a whole genome is several molecules, and a
   * metagenome's contigs are pieces of thousands. On a sequence with no declared
   * origin the control is offered greyed, saying where one comes from, rather
   * than hidden: a reader looking at a bacterial chromosome should find out the
   * reading exists.
   */
  private armsOf(state: ViewState): { arms?: ArmsPresentation } {
    if (state.view !== 'region' || state.region === undefined || state.region2 !== undefined) {
      return {}
    }
    const file = this.file
    if (file === null || file.info.hasGenomes) return {}
    const binsize = file.info.binsize ?? 0
    const names = this.contigNames()
    if (!(binsize > 0) || names === null) return {}
    const name = contigOf(state.region, names)
    if (name === null) return {}
    let startBin = 0
    let bins = 0
    let length = 0
    for (const [contig, bp] of contigPairs(file.contigs)) {
      const n = binsForLength(bp, binsize)
      if (contig === name) {
        bins = n
        length = bp
        break
      }
      startBin += n
    }
    if (bins === 0) return {}
    const declared = this.originStore()?.get(name)
    const circular = this.circularStore()?.has(name) === true
    // Offered on what can have arms: a circle, or a sequence somebody placed an
    // origin on. A yeast chromosome has neither and is not asked.
    if (declared === undefined && !circular) return {}
    // Where nobody has set one, the first base (§8.15): what every task reads
    // too, and where a complete bacterial assembly conventionally starts.
    const at = declared?.at ?? 0
    return {
      arms: {
        window: state.arms,
        frame: {
          startBin,
          n: bins,
          origin: Math.max(0, Math.min(bins - 1, Math.floor(at / binsize))),
          circular,
          binsize,
          length,
          originBp: at,
        },
        refusal: null,
        onChange: (window) => {
          // On turns the O/E on with it, for the reason the adaptive despeckle
          // does: it is a reading of the ratio and nothing else.
          this.store.patch({ arms: window, ...(window === undefined ? {} : { oe: true }) })
          this.rederive()
        },
        // The origin read when pressed, not when the view was built: a second
        // run of the task moves it, and the button must follow. Pressed while
        // lit — the origin already in the middle — it is undone: the sequence
        // framed as it is anywhere else, from its first base (§8.15).
        ...(!circular
          ? {}
          : {
              onCentre: (centred: boolean) => {
                // The hash does not follow a pan, so either answer can be the
                // state already held — the centred window panned away from, or
                // the whole sequence zoomed until the origin sat in the middle —
                // and a navigation to it moves nothing. The view is rebuilt on
                // its own region instead.
                const moved = centred
                  ? this.navigate(keepingScore(this.store.state, { uri: file.uri, view: 'region', region: name }))
                  : this.centreOnOrigin(file.uri, name, this.originStore()?.get(name)?.at ?? 0)
                if (!moved) this.remount()
              },
            }),
      },
    }
  }

  /**
   * Frame a circle with its origin in the middle (§8.15).
   *
   * A window across the junction, written the way the region box takes one —
   * an end below the start — that runs from half a lap after the origin round to
   * half a lap before it. One base short of a whole lap, because a window whose
   * two ends meet *is* the whole sequence and is named as one, from its first
   * base (`RegionView.zoomedRegion`), which would put the origin back at the
   * edge.
   *
   * @returns Whether the view state moved — `false` when it was already this
   *   window, which a pan away from it leaves in place — and `true` where there
   *   is no sequence length to frame by.
   */
  private centreOnOrigin(uri: string, name: string, origin: number): boolean {
    const length = contigPairs(this.file?.contigs ?? null).find(([contig]) => contig === name)?.[1]
    if (length === undefined || !(length > 2)) return true
    const from = (origin + Math.ceil(length / 2)) % length
    const to = (from - 1 + length) % length
    return this.navigate(keepingScore(this.store.state, { uri, view: 'region', region: `${name}:${from}-${to}` }))
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
    circle: boolean
    score?: string
  } {
    const info = this.file?.info
    return {
      hasWeights: info?.hasWeights === true,
      scoreColumns: info?.scoreColumns ?? ['count'],
      circle: this.onOneCircle(state),
      ...(state.score === undefined ? {} : { score: state.score }),
    }
  }

  /**
   * Whether the view is a window on one sequence declared circular — the one
   * view with two arms to read the baseline along (§8.15).
   *
   * Asked of the arms the map is offered, so the two cannot disagree: the
   * frame the `arms` toggle reads is the one `arm decay` is drawn in.
   */
  private onOneCircle(state: ViewState): boolean {
    // Asked on every resolution of the score, so the commonest answers — not a
    // region, or a file with no circle at all — are given before the walk
    // along the sequences that placing the arms costs.
    if (state.view !== 'region' || state.region2 !== undefined) return false
    if ((this.circularStore()?.list().length ?? 0) === 0) return false
    const arms = this.armsOf(state).arms
    return arms !== undefined && arms.refusal === null && arms.frame?.circular === true
  }

  /**
   * The colour scale in force: the state's fields over the file's defaults.
   *
   * @internal SessionRouter repaints a view with it.
   */
  scaleOf(state: ViewState): ScaleState {
    return scaleOf(state, this.balancedByDefault() ? { transform: 'log10' } : {})
  }

  /**
   * The scale a view's map is built on: the state's, the file's own defaults,
   * and what a derivation on the map {@link remount} took down had taken over
   * — spent here, by the one view built next for the same file (§7.5).
   */
  private seedOf(state: ViewState): PanelSeed {
    const carried = this.carriedScale
    this.carriedScale = null
    return {
      ...this.scaleOf(state),
      defaults: {
        transform: this.balancedByDefault() ? 'log10' : 'log1p',
        colormap: DEFAULT_UI_COLORMAP,
      },
      ...(carried === null || carried.uri !== state.uri ? {} : { restore: carried.restore }),
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
    const key = this.memoryKey(uri)
    return {
      initial: recall<TableUiState>(key, `table:${scope}`),
      save: (state) => remember(key, `table:${scope}`, state),
    }
  }

  /** @internal SessionCompare gates the second file on the first one's table. */
  async contigs(): Promise<ContigsResult> {
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

  /**
   * Whether a render of *state* that held *signal* has been overtaken.
   *
   * Three ways, and every step after an await asks all of them: the session is
   * gone; a newer render has started, which aborts the signal; or the store
   * moved on without starting one, which is what the comparison alone used to
   * catch and still does.
   *
   * @internal SessionRouter asks it after each of its awaits, as the mounts
   * here do; the DOM tests call it.
   */
  stale(state: ViewState, signal: AbortSignal): boolean {
    return this.destroyed || signal.aborted || this.store.state !== state
  }

  /**
   * Decides what a state means for this session and mounts it; holds nothing
   * of its own but a render's marker and its resolve latch (`SessionRouter`).
   */
  private readonly router = new SessionRouter(this)

  /**
   * Bring the screen in line with `state` — {@link SessionRouter.render}.
   *
   * Every caller comes through here, the store's subscription and the doors
   * that rebuild a view on purpose alike, because it is a seam: the DOM tests
   * replace it on the instance (`test/dom/deck-drop-many.test.ts`,
   * `test/dom/resolution-keys.test.ts`) or call it to start a second render of
   * one state (`test/dom/render-cancellation.test.ts`), and a caller that went
   * to the router directly would step round them. It hands back the router's
   * own promise, so an await of it takes the ticks it always took.
   */
  private render(state: ViewState | null): Promise<void> {
    return this.router.render(state)
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
   *
   * @internal SessionRouter fills the record card with it after a mount.
   */
  recordsFor(state: ViewState): RecordSpec[] {
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

  // -------------------------------------------------------------------------
  // The total the maps are drawn to (§6.5)
  // -------------------------------------------------------------------------

  /**
   * The total the tab's maps are drawn to, or `null` for the files as stored.
   *
   * @internal SessionCompare draws the second file to it.
   */
  get contactsTarget(): number | null {
    return this.store.state?.contacts ?? null
  }

  /** Draw every map of the tab to `contacts`, or put the files back (`null`). */
  private setContacts(contacts: number | null): void {
    if (contacts === this.contactsTarget) return
    this.store.patch({ contacts: contacts ?? undefined })
  }

  /** The box, with its questions answered by this session. */
  private contactsBoxFor(): ContactsBox {
    this.contactsBox = new ContactsBox({
      value: () => this.contactsTarget,
      own: () => this.totalOf(this.reader, this.file?.info.contacts ?? null),
      maps: () => this.mapTotals(),
      refusal: () => this.contactsRefusal(),
      onCommit: (contacts) => this.setContacts(contacts),
    })
    return this.contactsBox
  }

  /**
   * Tell a reader what to draw its map to, where it was last told something
   * else. Not awaited: the reads a view issues next queue behind the census in
   * the worker, and the answer arrives for the box, the captions and the tasks.
   *
   * @internal SessionCompare draws the second reader with it.
   */
  drawReader(client: ReaderClient, contacts: number | null): void {
    const held = this.drawn.get(client)
    if (held === undefined ? contacts === null : held.contacts === contacts) return
    const entry: DrawnState = { contacts, result: null, refusal: null }
    this.drawn.set(client, entry)
    const open = this.opens.get(client)
    client
      .request<'resample'>({ kind: 'resample', contacts })
      .then((result) => {
        if (this.opens.get(client) !== open) return
        // Kept whatever total was asked for since: the census does not depend
        // on one, and the next draw of this map can skip the walk.
        if (result.census !== null) this.censuses.set(client, result.census)
        if (this.drawn.get(client) !== entry) return
        entry.result = result
        this.contactsBox?.sync()
      })
      .catch((error: unknown) => {
        if (this.drawn.get(client) !== entry || isCancellation(error)) return
        entry.refusal = error instanceof Error ? error.message : String(error)
        this.contactsBox?.sync()
      })
  }

  /**
   * Every reader this session holds, drawn to the state's total.
   *
   * @internal SessionRouter calls it before every mount; the DOM tests replace
   * it on the instance.
   */
  syncContacts(state: ViewState): void {
    const contacts = state.contacts ?? null
    if (this.reader !== null && this.file !== null) this.drawReader(this.reader, contacts)
    if (this.compare.second !== null) this.drawReader(this.compare.second.client, contacts)
  }

  /** What a reader's map is drawn to, as a caption and a framing say it. */
  private depthOf(client: ReaderClient | null): DrawnDepth | null {
    const held = client === null ? undefined : this.drawn.get(client)
    const result = held?.result ?? null
    if (held === undefined || held.contacts === null || result === null || result.total === null) {
      return null
    }
    return { contacts: held.contacts, total: result.total, mode: result.mode }
  }

  /** A reader's map's contacts as stored: counted, where a census has, else as the file says. */
  private totalOf(client: ReaderClient | null, declared: number | null): number | null {
    if (client === null) return declared
    return this.censuses.get(client)?.total ?? this.counted.get(client) ?? declared
  }

  /**
   * Count the contacts a reader's map holds, where its file does not say — a
   * `.hic`, whose header counts each contact off a chromosome's diagonal twice.
   * In the background: the box shows the number when it lands, and the
   * chevrons wait for it.
   *
   * @internal SessionCompare counts the second file with it.
   */
  countOf(client: ReaderClient, info: OpenResult): void {
    if (info.contacts !== null) return
    const open = this.opens.get(client)
    client
      // Followed, and silently: its progress is not what any veil is up for,
      // and on the veil of a view that is reading it named the wrong wait.
      .request<'contacts'>({ kind: 'contacts' }, () => undefined)
      .then(({ total }) => {
        if (total === null || this.opens.get(client) !== open) return
        this.counted.set(client, total)
        this.contactsBox?.sync()
      })
      .catch(() => undefined)
  }

  /**
   * The total a task on a reader's map is drawn to, with the census it can skip
   * (§6.5).
   *
   * @internal SessionAnalysis runs a task on the map as it is drawn.
   */
  resampleOf(client: ReaderClient | null): { resample?: ResampleTarget } {
    const contacts = this.contactsTarget
    if (contacts === null || client === null) return {}
    const census = this.censuses.get(client)
    return { resample: { contacts, ...(census === undefined ? {} : { census }) } }
  }

  /** Every map on screen and what it holds, for the box's two chevrons. */
  private mapTotals(): MapTotal[] {
    const file = this.file
    if (file === null) return []
    const out: MapTotal[] = [
      { label: this.mapLabel(file.uri), total: this.totalOf(this.reader, file.info.contacts) },
    ]
    const second = this.compare.second
    if (second !== null) {
      out.push({ label: this.mapLabel(second.uri), total: this.totalOf(second.client, second.info.contacts) })
    }
    for (const { panel } of this.deck.grid?.analysable() ?? []) {
      if (panel.openInfo === null) continue
      out.push({ label: this.mapLabel(panel.uri), total: panel.contactsTotal })
    }
    return out
  }

  /** The first map that could not be drawn to the total, and why. */
  private contactsRefusal(): string | null {
    const lead = this.reader === null ? undefined : this.drawn.get(this.reader)
    if (lead?.refusal != null) return lead.refusal
    const second = this.compare.second
    const theirs = second === null ? undefined : this.drawn.get(second.client)
    if (second !== null && theirs?.refusal != null) return `${this.mapLabel(second.uri)}: ${theirs.refusal}`
    for (const { panel } of this.deck.grid?.analysable() ?? []) {
      const refusal = panel.drawRefusal
      if (refusal !== null) return `${this.mapLabel(panel.uri)}: ${refusal}`
    }
    return null
  }

  /**
   * File and genome context for the exported figure's caption.
   *
   * The panel can say what it drew — bin size, transform, level — but not what
   * it drew it *from*; that is the router's, because the uri and the genome are
   * view state.
   */
  private captionFor(state: ViewState): FigureSubject {
    return {
      file: this.mapLabel(state.uri),
      ...(state.genome === undefined ? {} : { genome: state.genome }),
      // Asked when the figure is drawn, since the reader's answer lands after
      // the view is built (§6.5).
      depth: () => this.depthOf(this.reader),
    }
  }

  /** @internal SessionRouter mounts the view through it. */
  mountGenomes(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const view = new GenomesTable({
      data: file.genomes,
      // Its own order unsorted, the reader's (§7.6).
      order: this.arrangedGenomes(),
      persistence: this.tableMemory(state.uri, 'genomes'),
      onOpenGenome: (genome) => this.navigate({ uri: state.uri, view: 'genome', genome }),
      onOpenSelection: (names) =>
        this.navigate({ uri: state.uri, view: 'selection', genomes: names.join(',') }),
      onOpenWhole: () => this.navigate({ uri: state.uri, view: this.wholeFileView() }),
      // The circle's own door (§7.6): every genome at genome level, which is the
      // one pass a circle of genomes needs — a ticked one drawn round as its
      // contigs, and several as one circle. The reading is written down here and
      // kept by every navigation after, as the turn is.
      ...(this.circlePresentation(state) === undefined
        ? {}
        : {
            onOpenCircle: (names: string[]) => {
              if (names.length === 0) {
                this.navigate({ uri: state.uri, view: 'overview', level: 'genome', circle: true })
              } else if (names.length === 1) {
                this.navigate({ uri: state.uri, view: 'genome', genome: names[0], circle: true })
              } else {
                this.navigate({ uri: state.uri, view: 'selection', genomes: names.join(','), circle: true })
              }
            },
          }),
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
   *
   * @internal SessionAnalysis hands it the per-cell task's table.
   */
  adoptCellMeasurements(uri: string, table: TableOutput): void {
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

  /** @internal SessionRouter mounts the view through it. */
  async mountCells(state: ViewState): Promise<void> {
    const signal = this.rendering.signal
    const file = this.file
    if (file === null) return
    const data = await this.cells()
    if (this.stale(state, signal)) return
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
   *
   * @internal SessionRouter calls it before every mount; the DOM tests replace
   * it on the instance.
   */
  async syncCells(state: ViewState): Promise<void> {
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

  /**
   * @internal SessionRouter mounts the view through it; the DOM tests replace
   * it on the instance.
   */
  async mountContigs(state: ViewState): Promise<void> {
    const signal = this.rendering.signal
    const file = this.file
    if (file === null) return
    const data = await this.contigs()
    if (this.stale(state, signal)) return
    // A plain cooler is opened as itself: no genome layer, no genome_id column,
    // and the chrom table is the landing view rather than a consolation prize.
    const cooler = !file.info.hasGenomes
    // …and on one, the landing view gets the 1D browser's bar over the table: a
    // ruler of the whole assembly that a drag names a window in. Withheld on a
    // metacool, where the same strip is a hundred thousand sub-pixel bands with
    // no name in any of them — see `ContigsTableOptions.assembly`.
    const assembly = cooler ? this.assemblyOfFile(file) : null
    const view = new ContigsTable({
      data,
      // In the reader's order (§7.6): genome by genome as placed, each one's
      // contigs in its own — the file's on a cooler, which has no order to keep.
      ...(cooler ? {} : this.arrangedContigRows(data)),
      hideColumns: cooler ? ['genome_id'] : [],
      title: cooler ? 'Chromosomes' : 'Contigs',
      // The same word the crumb and the title use, inside the table too: its
      // filter box and its empty state said `contig` under a heading reading
      // **Chromosomes** (§26.4).
      noun: cooler ? 'chromosome' : 'contig',
      hint: cooler
        ? 'One genome, its chromosomes. Pick one to see its map, or select a subset to compare them.'
        : undefined,
      ...(assembly === null ? {} : { assembly }),
      ...(this.annotations === null ? {} : { store: this.annotations.store }),
      // *This sequence is circular* (§8.15), as a column of ticks beside the
      // lengths. On a cooler alone, which is what {@link circularColumn} says
      // and why: a metacool's contig list is a hundred thousand pieces of four
      // thousand assemblies, and a declaration is made about a molecule somebody
      // knows the shape of.
      ...(cooler && this.circularColumn() !== null
        ? { circular: this.circularColumn() as CircularColumn }
        : {}),
      // Where each origin is, beside the circle it is on (§8.15). Cooler only,
      // for the circular column's reason.
      ...(cooler && this.originColumn() !== null
        ? { origins: this.originColumn() as OriginColumn }
        : {}),
      persistence: this.tableMemory(state.uri, 'contigs'),
      onOpenContig: (contig) =>
        this.navigate({ uri: state.uri, view: 'region', region: contig, genome: state.genome }),
      // The same destination a click on a row reaches, with coordinates on it —
      // and offered on a MAG's contig list too, where "open the whole contig
      // first" is exactly as expensive a detour as it is at the top level.
      onOpenRegion: (region: string) =>
        this.navigate({ uri: state.uri, view: 'region', region, genome: state.genome }),
      // Two windows typed in the box are the block between them (§5.4).
      onOpenPair: (region: string, region2: string) =>
        this.navigate({ uri: state.uri, view: 'region', region, region2, genome: state.genome }),
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

  /** @internal SessionRouter mounts the view through it. */
  mountWhole(state: ViewState): void {
    const file = this.file
    if (file === null) return
    const level = matrixLevel(state)
    if (level === 'bin' && this.binRefused.has(state.uri)) {
      this.navigate({ ...state, level: 'contig' }, { replace: true })
      return
    }
    const balance = this.balanceOf(state)
    // On a metagenome this view is one level of the whole-file picker rather
    // than a view of its own (see {@link mountOverview}), and is labelled and
    // clicked by genome like the other two. The picker itself is in the General
    // column's card, for every level and every file (`paintLevel`).
    const picker = this.isMetacool
    // The locus box's example, from the file in front of the reader (§26.6).
    const first = this.assemblyOfFile(file)?.contigs[0]?.name ?? null
    this.mountWholeFile(
      state,
      // The declared resolution is in the key for the reason `balance` is: the
      // block a whole-file view holds *is* the picture, and a reader stepping
      // from 1 kb to a derived 3 kb would otherwise be handed the cached 1 kb
      // one under a bar that says 3 kb (§3.4).
      `whole|${state.uri}|${this.compare.key()}|${level}|${String(balance)}|${state.coarsen ?? 0}|${state.contacts ?? 0}`,
      () => {
        return new WholeView({
          client: this.clientOf(),
          caption: this.captionFor(state),
          ...(picker
            ? {
                wholeFileLevel: {
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
          ...this.pooledProps(state),
          // The gate's other way out: the same picture from a coarser rung of
          // the same file, through the breadcrumb's own switch.
          onOpenRung: (entry: string) => {
            const next = `${splitUri(file.uri).path}::${file.info.entryGroup || 'entries'}/${entry}`
            void this.open(next, file.source, this.carryAcrossEntries(next))
          },
          nBins: file.info.nBins,
          nContigs: file.info.nContigs,
          displayExtent: file.info.displayExtent,
          // The file's own count of stored pixels, which is what the read walks.
          // A cooler that does not declare it is not gated rather than gated on
          // a guess; the same number is in the File card, from the same place.
          nnz: file.info.cellNnz ?? numberOr(file.info.info['nnz']),
          level,
          scale: this.seedOf(state),
          balance,
          ...this.scoreProps(state),
          noun: file.info.hasGenomes ? 'contig' : 'chromosome',
          // The example in the locus box, and what the read costs in bytes: the
          // gate priced itself in stored pixels alone, which is the wrong currency
          // for a reader on a network (§7.3, §18.6).
          ...(first === null ? {} : { first }),
          sourceKind: file.info.sourceKind,
          sourceBytes: file.info.sourceBytes,
          ...(this.annotationContext() === undefined
            ? {}
            : { annotations: this.annotationContext() }),
          ...(this.compare.context() === undefined ? {} : { compare: this.compare.context() }),
          // The two are mutually exclusive in practice and both are passed
          // anyway: a file either has a genome layer to name in the tooltip
          // (§7.4) or is a cooler that can carry annotations (§8.5), never both.
          namesGenomes: file.info.hasGenomes,
          onScoreChange: (choice) => this.setScore(choice),
          derive: this.derivePresentation(state),
          turn: this.turnPresentation(state),
          round: this.circleFor(state),
          ...this.panelOrder(),
          onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
          onOpenRegion: (region, region2) =>
            this.navigate({
              uri: state.uri,
              view: 'region',
              region,
              ...(region2 === undefined ? {} : { region2 }),
            }),
          onError: (err) => this.showError(err),
          onOutOfMemory: () => this.refuseBinLevel(state),
          start: this.takeStart(state.uri),
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
   *
   * @internal SessionRouter mounts the view through it.
   */
  async mountSelection(state: ViewState): Promise<void> {
    const signal = this.rendering.signal
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
      if (this.stale(state, signal)) return
    }
    const bins = this.binsOfSelection(selection)
    const contigs = this.contigsOfSelection(selection)
    const first = this.assemblyOfFile(file)?.contigs[0]?.name ?? null
    const view = new WholeView({
      client: this.clientOf(),
      caption: this.captionFor(state),
      binsize: file.info.binsize ?? 1,
      rungs: file.info.entries,
      ...this.pooledProps(state),
      nBins: file.info.nBins,
      nContigs: file.info.nContigs,
      displayExtent: file.info.displayExtent,
      nnz: file.info.cellNnz ?? numberOr(file.info.info['nnz']),
      level: 'bin',
      scale: this.seedOf(state),
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      noun: file.info.hasGenomes ? 'contig' : 'chromosome',
      ...(first === null ? {} : { first }),
      sourceKind: file.info.sourceKind,
      sourceBytes: file.info.sourceBytes,
      ...(this.annotationContext() === undefined
        ? {}
        : { annotations: this.annotationContext() }),
      ...(this.compare.context() === undefined ? {} : { compare: this.compare.context() }),
      namesGenomes: file.info.hasGenomes,
      selection: { ...selection, bins, contigs },
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      round: this.circleFor(state),
      ...this.panelOrder(),
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

  /** @internal SessionRouter mounts the view through it. */
  mountGenome(state: ViewState): void {
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
      ...this.pooledProps(state),
      genome: state.genome,
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      round: this.circleFor(state),
      ...this.panelOrder({ rows: state.genome, cols: state.genome }),
      ...(this.circularPresentation(state) === undefined
        ? {}
        : { circular: this.circularPresentation(state) }),
      neighbours: { prev: this.stepTarget(-1), next: this.stepTarget(1) },
      onStep: (delta) => this.step(delta),
      level: matrixLevel(state),
      scale: this.seedOf(state),
      onScaleChange: (scale) => this.store.patch(scale, { replace: true }),
      onOpenRegion: (region) =>
        this.navigate({ uri: state.uri, view: 'region', region, genome: state.genome }),
      onOpenContigPair: (region, region2) =>
        this.navigate({ uri: state.uri, view: 'region', region, region2, genome: state.genome }),
      onError: (err) => this.showError(err),
    })
    this.showContent(view.el, view)
  }

  /** @internal SessionRouter mounts the view through it. */
  mountPair(state: ViewState): void {
    const file = this.file
    if (file === null) return
    if (state.genome === undefined || state.genome2 === undefined) {
      this.navigate({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    const view = new PairView({
      client: this.clientOf(),
      ...(this.annotationContext() === undefined ? {} : { annotations: this.annotationContext() }),
      caption: this.captionFor(state),
      binsize: file.info.binsize ?? 1,
      rungs: file.info.entries,
      ...this.pooledProps(state),
      genomeNames: this.arrangedGenomes(),
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      round: this.circleFor(state),
      ...this.panelOrder({ rows: state.genome, cols: state.genome2 }),
      rowGenome: state.genome,
      colGenome: state.genome2,
      level: matrixLevel(state),
      scale: this.seedOf(state),
      onChangeGenomes: (genome, genome2) => this.navigate({ ...state, genome, genome2 }),
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

  /**
   * @internal SessionRouter mounts the view through it; the DOM tests replace
   * it on the instance.
   */
  async mountRegion(state: ViewState): Promise<void> {
    const signal = this.rendering.signal
    if (state.region === undefined) {
      this.navigate({ uri: state.uri, view: 'genomes' }, { replace: true })
      return
    }
    // The contigs table is what "next contig" steps through. It is read once
    // per file and cached, so this costs a read on the first region view and
    // nothing afterwards.
    if (this.file?.contigs == null) await this.contigs().catch(() => null)
    if (this.stale(state, signal)) return
    const keep = this.bookmarkButton()
    const view = new RegionView({
      client: this.clientOf(),
      caption: this.captionFor(state),
      ...(keep === undefined ? {} : { boxControl: keep }),
      binsize: this.file?.info.binsize ?? 1,
      rungs: this.file?.info.entries,
      ...this.pooledProps(state),
      region: state.region,
      noun: this.file?.info.hasGenomes === false ? 'chromosome' : 'contig',
      ...(this.annotationContext() === undefined ? {} : { annotations: this.annotationContext() }),
      ...(this.compare.context() === undefined ? {} : { compare: this.compare.context() }),
      balance: this.balanceOf(state),
      value: this.valueOf(state),
      ...this.scoreProps(state),
      onScoreChange: (choice) => this.setScore(choice),
      derive: this.derivePresentation(state),
      turn: this.turnPresentation(state),
      round: this.circleFor(state),
      ...this.panelOrder(this.regionAxes(state)),
      ...(this.circularPresentation(state) === undefined
        ? {}
        : { circular: this.circularPresentation(state) }),
      neighbours: { prev: this.stepTarget(-1), next: this.stepTarget(1) },
      onStep: (delta) => this.step(delta),
      ...(state.region2 === undefined ? {} : { region2: state.region2 }),
      ...(state.focus === undefined ? {} : { focus: state.focus }),
      scale: this.seedOf(state),
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

  /**
   * The whole-metagenome scan (§7.3), mounted like any other view.
   *
   * @internal SessionRouter mounts the view through it.
   */
  mountOverview(state: ViewState): void {
    const file = this.file
    if (file === null) return
    // A published edge list is a genome × genome overview for one small
    // download instead of a pass over the file, so where one is advertised
    // *that* is the cheapest thing to land on and the default gives way to it.
    // Only the default: a link that names a level has already chosen.
    const edgeListUrl = this.edgeListUrl()
    // The same count the whole-genome gate prices itself in, from the same
    // place as the File card's row.
    const nnz = file.info.cellNnz ?? numberOr(file.info.info['nnz'])
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
          // Both figures on both gates: the pixels are what a local read costs
          // and the bytes are what a remote one costs, and one gate used to
          // quote each (§7.3).
          ...(nnz === null ? {} : { nnz }),
          noun: file.info.hasGenomes ? 'contig' : 'chromosome',
          ...(edgeListUrl === undefined ? {} : { edgeListUrl }),
          level,
          scale: this.seedOf(state),
          genomeNames: this.arrangedGenomes(),
          round: this.circleFor(state),
          ...this.panelOrder(),
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
          start: this.takeStart(state.uri),
        }),
    )
  }

  /**
   * The bin-level whole-file read ran out of memory: go one level up, and stop
   * offering the level that failed (§7.3).
   *
   * One level up is `contig × contig` on a metagenome and `chromosome ×
   * chromosome` on a cooler — `level=contig` both — and it is started at once,
   * because the reader pressed *compute* for a pass over every pixel and this is
   * that pass, at the level the machine can hold. Its accumulator is budgeted
   * (`worker/overview.ts`), which the bin level's fixed raster-sized block is not.
   */
  private refuseBinLevel(state: ViewState): void {
    this.binRefused.add(state.uri)
    this.startNext = state.uri
    this.navigate({ ...state, level: 'contig' }, { replace: true })
  }

  /** Whether the whole-file view about to be built should skip its gate, once. */
  private takeStart(uri: string): boolean {
    if (this.startNext !== uri) return false
    this.startNext = null
    return true
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
    // A whole-file view is kept while the file is open, and the circle may have
    // been turned on or off on another view since it was built (§7.6).
    view.panel.setCircle(this.circleFor(state))
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
  /**
   * @returns whether the store actually moved, so a caller can render by hand.
   *
   * @internal The collaborators navigate through it, so that what the reader
   * put on screen beside the view is carried as it is here.
   */
  navigate(next: ViewState | null, options: { replace?: boolean } = {}): boolean {
    const carried = next === null ? null : this.withCompanions(next)
    const moved = !viewStateEquals(carried, this.store.state)
    // Another picture, on the scale it names: what a rebuild of this one
    // carried is not its to give back.
    if (moved) this.carriedScale = null
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
    // reader who asked for the turn keep it, `flip: true` being a thing said.
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

  /**
   * What is held behind the next mounted view's first picture: a file's track
   * reads and its circularity measurement (§8.6, §8.15).
   */
  private pictureWaiters: Array<() => void> = []

  /**
   * Settles once the next view mounted has drawn its first block — at once for
   * a view with no map to draw — or after {@link MAP_FIRST_CAP_MS}, whichever
   * comes first.
   *
   * The map is the picture the reader opened, and until it is drawn nothing
   * else a file brings with it should be competing for the connection or the
   * reader: a session's twelve-megabyte FASTA and ten-megabyte gene model, and
   * up to fifty corner reads measuring which sequences are circles, all used to
   * start in the same moment as the map's first read.
   */
  private firstPicture(): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer = 0
      const done = (): void => {
        window.clearTimeout(timer)
        resolve()
      }
      timer = window.setTimeout(done, MAP_FIRST_CAP_MS)
      this.pictureWaiters.push(done)
    })
  }

  /** @internal SessionRouter puts on screen what it decides through it. */
  showContent(
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
    // What was held behind the first picture goes once this view has drawn
    // one, or now for a view with nothing to draw. A screen that is not a view
    // — a loading line, the picker — releases nothing; the cap does.
    if (view !== undefined && this.pictureWaiters.length > 0) {
      const waiting = this.pictureWaiters.splice(0)
      void (view.panel?.firstData ?? Promise.resolve()).then(() => {
        for (const done of waiting) done()
      })
    }
    // Whichever stop of the map/tracks cycle we are at, applied to the panel
    // that has just been built. Here rather than in the four views that own a
    // panel: they are handed a picture to draw, and which furniture goes round
    // it is the session's answer — the same reason the toggle itself lives here.
    view?.panel?.showLanes(!this.mapOnly)
    this.trackCard?.setMapOnly(this.mapOnly)
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
    this.deck.contentNode = node
    // …but only for a view the companions can answer. A table or an overview is
    // of *this file* and nothing else, so framing one put a genomes table into
    // one sixth of the column beside five rectangles each saying it has nothing
    // to draw. The deck is kept — navigating back to a map must not cost five
    // files reopened — it simply stops being a frame while there is nothing for
    // it to be a frame around.
    this.contentEl.replaceChildren(this.deck.framed(node))
    if (this.deck.grid !== null) this.deck.syncLead(this.deck.grid)
    // Emptied rather than hidden when a view has no controls: a table view
    // offers no aesthetics, so the column leaves the layout and its button goes
    // with it — the same rule the other two follow.
    // The structure cell's card beside the map's (§25.3): its settings are a
    // view's settings, and a view's settings are in this column.
    this.refreshAesthetics()
    // After the view is mounted, because the framing and the block a task runs
    // on are read off whatever is on screen *now* (§18.4) — and because a table
    // view has neither, which is a state the panel has to be able to show.
    this.analysis.sync()
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
      this.folderAsked(config.state.uri),
      this.picker.el,
    )
  }

  /**
   * The folder a waiting file is known to be in, where the installed app has
   * no grant for it (§20.6): a sentence naming it, and a button that connects
   * it — after which the session finds the file there on its own
   * ({@link foldersChanged}). Nothing where the file has no known place, and
   * nothing outside the installed app, which keeps no folder to find one in.
   */
  private folderAsked(uri: string): HTMLElement | null {
    const wanted = missingFolderOf(uri)
    if (wanted === null) return null
    const button = el('button', {
      class: 'btn',
      type: 'button',
      text: `Connect ${wanted.name}…`,
      title: `Choose the folder called ${wanted.name} on this machine; ${fileLabel(uri)} is at ${wanted.path} in it`,
    })
    button.addEventListener('click', () => {
      void connectDirectory().then((id) => {
        if (id !== null) this.host.folderConnected(id)
      })
    })
    return el(
      'div',
      { class: 'folders-asked' },
      el('p', {
        class: 'hint',
        text:
          `It was in a folder called ${wanted.name}, at ${wanted.path}. Connect that folder and it is ` +
          'found there, with every other file of this session that was in it.',
      }),
      button,
    )
  }

  /** @internal SessionRouter shows it for a local file a link names. */
  pickerWithNote(uri: string): HTMLElement {
    return el(
      'div',
      { class: 'view' },
      el('p', {
        class: 'inline-error',
        text:
          `This link points at ${fileLabel(uri)}, which is not a URL this page can fetch — it names ` +
          'a local file. Drop the same file below to follow the link; the rest of the view ' +
          // A genome is a place only a multi-genome file has — a dev feature (§29).
          (devFeature('metacool') ? '(genome, region, colour scale)' : '(region, colour scale)') +
          ' will be restored.',
      }),
      this.folderAsked(uri),
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
      // A total the contacts box asked for that this map cannot be drawn to
      // (§6.5): the way out is the files as stored, one press away.
      onReadAsStored:
        err instanceof ViewerError && err.detail['resample'] === true && this.contactsTarget !== null
          ? () => this.setContacts(null)
          : undefined,
    })
    this.showContent(view.el)
  }


  // -------------------------------------------------------------------------
  // The four columns
  // -------------------------------------------------------------------------

  /** @internal SessionAnalysis fills the column through it. */
  setAnalysis(nodes: readonly HTMLElement[]): void {
    this.analysisHost.replaceChildren(...nodes)
    this.setAvailability('analysis', nodes.length > 0)
  }

  /** @internal SessionRouter fills and empties the column through it. */
  setGeneral(nodes: readonly HTMLElement[]): void {
    this.generalHost.replaceChildren(...nodes)
    this.setAvailability('general', nodes.length > 0)
  }

  /** @internal SessionRouter empties the column through it; the DOM tests call it. */
  setAnnotations(nodes: readonly HTMLElement[]): void {
    this.annotationsHost.replaceChildren(...nodes)
    this.setAvailability('annotations', nodes.length > 0)
  }

  /**
   * The Aesthetics column as it should be now: the view's own controls, then
   * the structure cell's card where the deck has one (§25.3). Called when a
   * view is mounted and whenever the deck's cells change, because either can
   * happen after the other.
   *
   * @internal SessionDeck calls it when a cell changes what the column holds.
   */
  refreshAesthetics(): void {
    const side = this.current?.sideEl
    this.placeMapCard(side)
    const card = this.deck.grid?.structureSettings() ?? null
    // A card the enlarged dialog has borrowed stays where it is: the dialog
    // gives it back when it closes.
    // Held by the host where the reader has moved it to another column, too:
    // its builder's spot is still here (`ui/cardLayout.ts`).
    const borrowed = card !== null && card.isConnected && !hostHolds(this.aestheticsHost, card)
    // The card placed last time, taken out where the deck no longer has it.
    const placed = this.placedStructureCard
    if (placed !== null && placed !== card && hostHolds(this.aestheticsHost, placed)) removeCard(placed)
    this.placedStructureCard = null
    if (side === undefined) {
      this.setAesthetics(card === null || borrowed ? [] : [card])
      return
    }
    if (card !== null && !borrowed) {
      // Inside the view's own aside, right after its *Map* card and before
      // the tracks and the groups (§25.3): the model is a view of the same
      // thing the map is, so its card stands with the map's. A view without
      // a map card takes it last.
      const map = this.placedMapCard?.card ?? this.current?.panel?.controlsEl
      if (map !== undefined && homeParent(map) === side) afterHome(map, card)
      else side.append(card)
      this.placedStructureCard = card
    }
    this.setAesthetics([side])
  }

  /**
   * Put the **starred** map's *Map* card where the first map's stands (§16.5).
   *
   * The column holds one Map card, and it is the starred map's: the first
   * map's own while it is starred — and while nothing is, when that card sets
   * every map — and a companion's while the star is on it. Swapped in place in
   * the view's aside, so the cards around it (Export, Tracks, the 3D
   * structure) stay where they were, and swapped back the moment the star
   * moves off, the companion closes, or the view is rebuilt with a card of its
   * own.
   */
  private placeMapCard(side: HTMLElement | undefined): void {
    const lead = this.current?.panel?.controlsEl
    const wanted = this.deck.grid?.mapCard() ?? null
    const held = this.placedMapCard
    // Where each card's builder put it, rather than where it stands: a reader
    // may have moved the Map card to another column, and the swap is still
    // this aside's (`ui/cardLayout.ts`).
    if (held !== null && (held.card !== wanted || held.lead !== lead || homeParent(held.card) !== side)) {
      // The first map's card back where the companion's stood. Into a view
      // that has since been rebuilt, too: that aside is gone, and putting its
      // own card back in it costs nothing and leaves the companion's free.
      swapCard(held.card, held.lead)
      this.placedMapCard = null
    }
    if (wanted === null || lead === undefined || side === undefined) return
    if (this.placedMapCard !== null) return
    if (homeParent(lead) !== side) return
    swapCard(lead, wanted)
    this.placedMapCard = { card: wanted, lead }
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
 * report replaces it with a bar, a line of prose under the file's name, and a
 * way to stop. The heading is not the line that changes: it names the file, and
 * a reader with two tabs opening needs it to go on doing so. The bar is
 * per *phase* rather than across the whole open: downloading is measured in
 * bytes and parsing in pixels, and one bar sliding between two denominators
 * would look like it had gone backwards. Two labelled sweeps is what a reader
 * can actually follow.
 */
export class LoadingView {
  readonly el: HTMLElement
  private readonly text: HTMLElement
  /**
   * The phase and its count, under the bar rather than over the heading.
   *
   * Because the heading stays: `report()` used to overwrite the only line on
   * screen, so "Opening Yeast_G2M.scool…" became "downloading — 1.2 MB of
   * 18.1 MB" and then "reading pixels — 1,204 of 14,769,558" — a sentence with
   * the file's name in it turning into a lowercase fragment halfway through a
   * minute-long open, in a window that may have two of them going.
   */
  private readonly note: HTMLElement
  private readonly bar: HTMLProgressElement
  private readonly box: HTMLElement
  private readonly ring: HTMLElement

  constructor(message: string, onCancel?: () => void) {
    this.text = el('p', { class: 'loading-text', text: `${message}…` })
    this.note = el('p', { class: 'loading-note hidden' })
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
    this.ring = el('div', { class: 'spinner', attrs: { role: 'progressbar', 'aria-label': message } })
    this.el = el('div', { class: 'loading' }, this.ring, this.text, this.box, this.note)
  }

  /**
   * Show what the worker is doing now.
   *
   * A `total` of zero is *indeterminate* rather than *finished* — a host that
   * states no `Content-Length` gives one — so the bar loses its value and the
   * browser draws it as the barber's pole it has for exactly this.
   *
   * The ring goes on the first report, which is what this class's own header
   * promises: two meters for one wait is a spinning ring above a filling bar,
   * both carrying `role="progressbar"`, so a screen reader announced two jobs
   * and a sighted reader wondered which one was theirs.
   */
  report(done: number, total: number, note?: string): void {
    this.ring.classList.add('hidden')
    this.box.classList.remove('hidden')
    this.note.classList.remove('hidden')
    const phase = note ?? 'reading'
    if (total > 0) {
      this.bar.value = Math.min(1, done / total)
      this.note.textContent = `${phase} — ${describe(done, total, note)}`
    } else {
      this.bar.removeAttribute('value')
      // Nothing counted *and* nothing to count it against is a phase that has
      // only a name — the cell listing is one, and `0 B` beside it would read
      // as a stalled download rather than as a wait with no meter on it.
      this.note.textContent = done > 0 ? `${phase} — ${fmt.bytes(done)}` : `${phase}…`
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
 * The state a press of `ori` navigates to, with the score of the map it was
 * pressed on (§8.15).
 *
 * A navigation starts from the file's own score, and for most of them that is
 * right: another sequence, or a box drawn on the map, is another picture. `ori`
 * is not — it frames the same sequence another way, the origin in the middle or
 * the first base at the corner, and a reader who picked `arm decay` pressed it to
 * see the two diagonals as an X, not to be put back on balanced counts. So the
 * score comes with it, and the balancing that is the other half of a score
 * (`Session.setScore`). The same file only, and a state that has said something
 * about either key is believed, as `Session.navigate` believes one about the
 * keys it carries.
 *
 * Exported for the test, as `compareRung` is from `SessionCompare.ts`: the
 * press itself needs a worker, an open file and a circle to reach.
 */
export function keepingScore(held: ViewState | null, next: ViewState): ViewState {
  if (held === null || held.uri !== next.uri) return next
  return {
    ...next,
    ...(held.score === undefined || 'score' in next ? {} : { score: held.score }),
    ...(held.balance === undefined || 'balance' in next ? {} : { balance: held.balance }),
  }
}

/**
 * The junction test's reads for one sequence at a sibling rung (§8.15).
 *
 * The test is written in the sequence's own bins at that rung, and the reader
 * takes windows in bins of the *open* map with the rung named beside them,
 * converting itself (`WorkerRequest` `matrix.rung`). So a window's start goes
 * over rounded up and its end rounded down, which the reader's conversion takes
 * back to exactly the bins meant; the sequence's end goes over as its end. A
 * block that still comes back another shape — a level that absorbed the
 * sequence's last part-bin, so its bins are not the ones counted here — throws
 * {@link JunctionRungMismatch}, and the sequence is measured at the open rung.
 */
/** A sibling rung that could not give the junction test the block it asked for. */
class JunctionRungMismatch extends Error {}

function junctionReaderAt(
  client: ReaderClient,
  sequence: JunctionCandidate,
  binsAtRung: number,
  open: number,
  rung: number,
  balance: boolean,
): JunctionReader {
  const scale = rung / open
  const start = (bin: number): number => sequence.from + Math.min(sequence.n - 1, Math.ceil(bin * scale))
  const end = (bin: number): number =>
    sequence.from + (bin >= binsAtRung ? sequence.n : Math.min(sequence.n, Math.floor(bin * scale)))
  return async (rows, cols) => {
    const read = await client.request<'matrix'>({
      kind: 'matrix',
      rung: String(rung),
      rows: [start(rows[0]), end(rows[1])],
      cols: [start(cols[0]), end(cols[1])],
      balance,
      background: true,
    })
    const nrows = rows[1] - rows[0]
    const ncols = cols[1] - cols[0]
    if (read.nrows !== nrows || read.ncols !== ncols) throw new JunctionRungMismatch()
    return read.values
  }
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

function sameScope(a: MetaScope, b: MetaScope | null): boolean {
  if (b === null || a.kind !== b.kind) return false
  return a.kind === 'genomes' || (b.kind === 'contigs' && a.genome === b.genome)
}

/** One entry of the level select: the value in the URL, its name, what a cell holds. */
interface LevelChoice {
  value: 'bin' | 'contig' | 'genome'
  label: string
  hint: string
  disabled?: boolean
}

/** Why `bin × bin` is greyed out, once this tab could not hold it. */
/**
 * A metagenome whose every contact the stage reads for where a genome's
 * contigs belong without being asked (§27.10): a pass of a few seconds at most.
 */
const LINKS_AUTO_PIXELS = 50_000_000

const BIN_REFUSED = 'bin × bin ran out of memory in this tab.'

/**
 * The longest a file's tracks wait for its map's first block (§8.6).
 *
 * Long enough for a region's first read on an ordinary line — three seconds
 * for the demo's at 25 Mbit/s — and short enough that a map whose first
 * picture is a minute's scan does not hold every track for that minute.
 */
const MAP_FIRST_CAP_MS = 4000

/**
 * Which levels the view on screen can draw, or `null` for none (§7.3).
 *
 * A metagenome's whole-file view offers all three; a genome or a pair, bins or
 * contigs; a cooler's whole genome, bins or chromosomes — and only with more
 * than one, where every level would be a single cell. Everything else is at the
 * one level it has.
 */
function levelChoices(
  state: ViewState,
  hasGenomes: boolean,
  nContigs: number,
  landing?: 'genome',
  binRefused = false,
): { options: LevelChoice[]; current: string } | null {
  // Greyed out rather than removed: a level that vanished from the list would
  // leave the reader wondering where the default went.
  const refuse = (options: LevelChoice[]): LevelChoice[] =>
    binRefused
      ? options.map((choice) =>
          choice.value === 'bin' ? { ...choice, disabled: true, hint: BIN_REFUSED } : choice,
        )
      : options
  if (hasGenomes && state.view === 'overview') {
    return { options: refuse([...WHOLE_FILE_LEVELS]), current: landing ?? overviewLevel(state) }
  }
  const pair = (contig: string): LevelChoice[] => [
    { value: 'bin', label: 'bin × bin', hint: 'Equal-width bins: one colour scale fits the whole map.' },
    { value: 'contig', label: `${contig} × ${contig}`, hint: `One cell per ${contig}.` },
  ]
  if (hasGenomes && (state.view === 'genome' || state.view === 'pair')) {
    return { options: pair('contig'), current: matrixLevel(state) }
  }
  if (!hasGenomes && state.view === 'whole' && nContigs > 1) {
    return { options: refuse(pair('chromosome')), current: matrixLevel(state) }
  }
  return null
}

/** Whether two edits apply the same steps — the same assembly, whatever was undone after them. */
function sameSteps(a: ReferenceEdit | undefined, b: ReferenceEdit | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.cursor !== b.cursor) return false
  return JSON.stringify(a.history.slice(0, a.cursor).map((entry) => entry.step)) ===
    JSON.stringify(b.history.slice(0, b.cursor).map((entry) => entry.step))
}
