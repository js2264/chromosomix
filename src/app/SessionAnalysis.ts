/**
 * The session as the Analysis column sees it (§18): the host the workspace
 * reads it through, the context a task is priced and run against, and when
 * the workspace is built, refreshed and put down.
 *
 * `analysis/workspace.ts` is the workspace — a runner, a worker, the panel and
 * the drawer — loaded in a chunk of its own the first time a file is open, and
 * every question it asks is answered from facts the session holds: which file
 * is open and which map is starred, the framing and the block on screen, the
 * circles and origins declared on the file, the maps beside it that a task can
 * be run against or compared with. This is where those answers are put in the
 * workspace's terms, and they are read fresh each time they are asked.
 *
 * Separate from `Session` because it is the one part of it that speaks the
 * analysis module's language — framings, run targets, contexts — and the
 * session's other sections never do. It holds nothing but the workspace and
 * whether its chunk is in flight.
 */

import { buildAnalysisContext } from '../analysis/context'
import type { RunTarget } from '../analysis/runner'
import { readsMap, type AnalysisContext, type AnalysisFraming, type AnalysisTask } from '../analysis/types'
import type { AnalysisWorkspace, AnalysisWorkspaceHost } from '../analysis/workspace'
import { LEAD_MAP } from '../annotations/placement'
import { browsingBinsize } from '../genome/assembly'
import type { AnalysisFacts } from '../panels/MapPanel'
import { fileBaseLabel } from '../ui/labels'
import { rungsOf } from '../ui/refine'
import type { OpenResult, OrientationSummary, PairsBinning } from '../worker/protocol'
import type { PairStats } from '../pairs/stats'
import type { Session } from './Session'

/**
 * What the Analysis column says while a deck has no map starred (§18.1): one
 * sentence, above every greyed row and in Run's refusal. The 1D tasks read no
 * map, so they are the ones left to run, and the sentence says so rather than
 * leaving a reader to wonder why one card is not greyed.
 */
const NO_STAR_TASKS =
  'No map is starred, so only the 1D tasks can run: every other task reads one map, and the star ' +
  'is how it is named. Star a map in its heading to run them.'

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
  origins: Readonly<Record<string, number>> = {},
): AnalysisFraming | null {
  if (framing === null) return framing
  const hasOrigins = Object.keys(origins).length > 0
  if (names.length === 0 && !hasOrigins) return framing
  return {
    ...framing,
    ...(names.length === 0 ? {} : { circular: names }),
    // The declared origins travel beside the circles they are on, for the same
    // reason: facts about the molecule that change what an arm-reading task
    // computes, so they belong in its provenance (§8.15).
    ...(hasOrigins ? { origins: { ...origins } } : {}),
  }
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
  pairsStats?: PairStats
} {
  if (info.pairs === undefined) return {}
  return {
    binning: info.pairs.binning,
    ...(info.pairs.orientation === null ? {} : { orientation: info.pairs.orientation }),
    // And what `pairtools stats` counted in the same pass, which Pairs QC draws
    // as it draws the curves: from the import, with nothing read again.
    ...(info.pairs.stats === null ? {} : { pairsStats: info.pairs.stats }),
  }
}

export class SessionAnalysis {
  /**
   * The Analysis panel, the drawer and the synthetic tracks card (§18).
   *
   * One object for all three, because they share a runner and a worker and are
   * created and destroyed together with the file — see `analysis/workspace.ts`
   * for why the wiring lives there rather than adding three hundred lines here.
   * `null` until a file is open, and dropped with it.
   */
  workspace: AnalysisWorkspace | null = null
  /** Set while the workspace's chunk is in flight, so it is fetched once. */
  private loading = false

  constructor(private readonly session: Session) {}

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
  sync(): void {
    // Keyed on the *context* rather than on a file, because a 1D browser session
    // has no file and still has three tasks it can run (§5.8). What decides the
    // column is whether there is anything at all to analyse.
    if (this.context() === null) {
      this.workspace?.destroy()
      this.workspace = null
      this.session.setAnalysis([])
      this.session.drawerHost.replaceChildren()
      return
    }
    if (this.workspace === null) {
      void this.load()
      return
    }
    this.paint(this.workspace)
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
  private async load(): Promise<void> {
    if (this.loading) return
    this.loading = true
    try {
      const { AnalysisWorkspace } = await import('../analysis/workspace')
      // Everything below is re-checked because an await is a gap: the tab may
      // have been closed, or the file replaced, while the chunk was in flight.
      if (this.session.destroyed || this.context() === null || this.workspace !== null) return
      this.workspace = new AnalysisWorkspace(this.workspaceHost())
      // The workspace brings its own carried rows back through the same `begin`
      // an import goes through, so they arrive on the lead like everything else
      // — and a computed row's map is exactly the fact a batch existed to
      // record. The snapshot is still here, so it is applied again over what the
      // workspace has just added ({@link Session.adoptCarriedLanes}).
      this.session.adoptCarriedLanes()
      this.paint(this.workspace)
    } catch {
      // A chunk that will not load is a viewer with no Analysis column, which
      // is a state the shell already handles — every other panel can be absent
      // too. Not worth an error screen over a feature nothing else depends on.
    } finally {
      this.loading = false
    }
  }

  private paint(analysis: AnalysisWorkspace): void {
    analysis.refresh()
    // The column carries the list; the drawer floats over the body and is the
    // shell's to place, which is why the two are separate hosts.
    this.session.setAnalysis(analysis.hasTasks ? [analysis.panelEl] : [])
    this.session.drawerHost.replaceChildren(analysis.drawerEl)
  }

  /** The callbacks `AnalysisWorkspace` reads the session through. */
  private workspaceHost(): AnalysisWorkspaceHost {
    return {
      source: (task) => {
        const starred = this.starredFacts(task)
        if (starred !== null) {
          return {
            uri: starred.uri,
            source: starred.source,
            ...cellsOfMap(starred.info),
            ...binningOfMap(starred.info),
            ...(this.session.deck.grid?.starredPanel?.resampleTarget() ?? {}),
            // What a plain Run names the map it measured (§16.10), as a batch
            // names each of its maps (`readyTargets`).
            label: this.session.mapLabel(starred.uri),
          }
        }
        const file = this.session.file
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
            ...this.session.resampleOf(this.session.reader),
            ...(this.session.lens === null ? {} : { edit: this.session.lens.edit }),
            label: this.session.mapLabel(file.uri),
          }
        }
        // **The genome, where there is no map.** Three tasks run entirely on
        // loaded tracks and a 1D browser session is exactly where a reader has
        // the tracks and not the matrix (§18.3) — `context` says so and
        // builds them a context, and the runner answers a missing framing with
        // one over the tracks. This was the last line still assuming a matrix:
        // with none, every one of the three failed as *nothing is open*, in the
        // session shape they were written for.
        //
        // Nothing mounts this. A track-only chain never opens a file in the
        // analysis worker (`AnalysisRunner.mount`), so what the pair is for is
        // the record: a result names the file it is a measurement of, and here
        // that is the genome the tracks were loaded against.
        const assembly = this.session.assembly
        const source = this.session.assemblySource
        return assembly === null || source === null
          ? null
          : { uri: assembly.uri, source }
      },
      context: (task) => this.context(task),
      // Read fresh on every call rather than cached: `Run` takes the framing at
      // the instant it is pressed, and a cached one would be a record of
      // wherever the reader happened to be when the drawer opened.
      framing: () => {
        const starred = this.session.deck.grid?.starredPanel ?? null
        if (starred !== null) {
          const facts = starred.analysisFacts()
          const framed = facts === null ? null : (starred.map?.analysisFraming(facts.uri) ?? null)
          return this.session.withEditOf(
            withCircularNames(
              framed,
              this.session.circularStore()?.list() ?? [],
              this.session.originStore()?.record() ?? {},
            ),
          )
        }
        const file = this.session.file
        const panel = this.session.current?.panel
        return file === undefined || file === null || panel === undefined
          ? null
          : this.session.withEditOf(
              withCircularNames(
                // At the resolution the reader added, where the map is drawn at
                // one (§3.4): the framing every task on it is run at.
                panel.analysisFraming(file.uri, this.session.analysisGrid()),
                this.session.circularStore()?.list() ?? [],
                this.session.originStore()?.record() ?? {},
              ),
            )
      },
      block: () => {
        const starred = this.session.deck.grid?.starredPanel ?? null
        if (starred !== null) return starred.map?.analysisBlock() ?? null
        // None at a resolution the reader added: the runner reads the map summed
        // (§3.4), and the block drawn is another sum of it.
        if (this.session.analysisGrid() !== null) return null
        return this.session.current?.panel?.analysisBlock() ?? null
      },
      store: () => this.session.annotations?.store ?? null,
      // The same object both surfaces draw groups from, so a suggestion a task
      // makes about its own set (§18.11) means the same thing beside the map and
      // in the 1D browser.
      groups: () => this.session.annotations?.groups ?? null,
      // The one result that goes to a table rather than to the drawer (§3.8).
      cellMeasurements: (uri, table) => this.session.adoptCellMeasurements(uri, table),
      // The origins an Origin and terminus run placed, into the declarations.
      originsFound: (uri, origins) => this.session.adoptOrigins(uri, origins),
      // The star, so a measurement lands on the picture it was measured from.
      targetMap: () => this.session.deck.grid?.starredMap ?? LEAD_MAP,
      // A deck the reader has left with no map starred has no file for a task
      // that reads a map to run against, and none is guessed for them (§18.1).
      // The 1D tasks read only the tracks, and the column and drawer let them by.
      blocked: () => {
        const deck = this.session.deck.grid
        return deck !== null && deck.starredMap === null ? NO_STAR_TASKS : null
      },
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
          (this.session.deck.grid?.analysable() ?? [])
            .filter(({ panel }) => panel.analysisFacts() === null)
            .map(({ panel }) => panel.prepareAnalysis(() => this.workspace?.refresh())),
        )
        if (this.session.destroyed) return []
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
        (this.session.file === null ? 0 : 1) + (this.session.deck.grid?.analysable().length ?? 0),
      annotations: () => this.session.annotations?.client ?? null,
      // Taken rather than read: the rows belong to the first workspace built
      // after the switch, and a second one — a later navigation, a reload of the
      // chunk — must not be handed the same numbers again under ids the store
      // already holds.
      carried: () => {
        const rows = this.session.carriedAnalysis ?? []
        this.session.carriedAnalysis = null
        return rows
      },
      contigs: (task) =>
        (this.context(task)?.contigs ?? []).map((contig) => ({
          name: contig.name,
          startBin: contig.startBin,
          bins: contig.bins,
          length: contig.length,
        })),
      changed: () => {
        this.session.setAnalysis(this.workspace?.hasTasks === true ? [this.workspace.panelEl] : [])
      },
    }
  }

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
   *
   * And `null` for a task that reads no map, whichever map is starred (§18.1).
   * A 1D task reads the session's tracks, and is framed, priced and laid out on
   * the session's own map: with the star's, moving the star changed the
   * sequences it offered and the grid its lanes were cut on — two answers to
   * one question, under a Run that says the star is nothing to it.
   */
  private starredFacts(task?: AnalysisTask): AnalysisFacts | null {
    if (task !== undefined && !readsMap(task)) return null
    return this.session.deck.grid?.starredPanel?.analysisFacts() ?? null
  }

  /**
   * Every map on screen **except the one a context is about** — the star — for a
   * task that compares two files (§18.1); a map cannot be a peer of itself.
   *
   * A map counts **once its file has opened**: its name, its address and its
   * bin size are all a peer is asked for, and a companion has them as soon as it
   * has drawn. The two tables a run also reads are asked for here as well, once
   * per panel and as `readyTargets` asks, since a companion reads them only when
   * asked and nothing asked until a batch or a star did — so a deck of two
   * offered Reproducibility as *waiting for a second map*. A run waits for them
   * (`AnalysisRunner`'s inputs, through `allTargetsReady`), so the first one in a
   * fresh deck finds every map rather than none.
   *
   * The lead is one of them whenever the star is on a companion: it is a map on
   * screen like the others, and the runner already compares it. Each is named
   * what the reader calls it (§16.10).
   */
  private peersOf(uri: string): Array<{ label: string; uri: string; binsize: number }> {
    const out: Array<{ label: string; uri: string; binsize: number }> = []
    const file = this.session.file
    if (file !== null && file.uri !== uri) {
      out.push({ label: this.session.mapLabel(file.uri), uri: file.uri, binsize: file.info.binsize ?? 0 })
    }
    for (const { panel } of this.session.deck.grid?.analysable() ?? []) {
      if (panel.analysisFacts() === null) void panel.prepareAnalysis(() => this.workspace?.refresh())
      const info = panel.openInfo ?? panel.analysisFacts()?.info ?? null
      if (info === null || panel.uri === uri) continue
      out.push({ label: this.session.mapLabel(panel.uri), uri: panel.uri, binsize: info.binsize ?? 0 })
    }
    return out
  }

  /**
   * The maps a task can run against, as the runner's targets.
   *
   * One list built two ways, which is the point of the parameter: the
   * synchronous caller wants whatever is ready *and* wants the rest to start
   * reading, and the awaiting one has already waited and must not kick off a
   * second round of the same reads. Both give the maps in the grid's order,
   * which is the order a reader looking at the grid expects a batch to follow.
   */
  private readyTargets(options: { start: boolean }): RunTarget[] {
    const out: RunTarget[] = []
    const file = this.session.file
    let lead: RunTarget | null = null
    if (file !== null) {
      lead = {
        map: LEAD_MAP,
        uri: file.uri,
        source: file.source,
        ...cellsOfMap(file.info),
        ...binningOfMap(file.info),
        ...this.session.resampleOf(this.session.reader),
        ...(this.session.lens === null ? {} : { edit: this.session.lens.edit }),
        // What the reader calls it (§16.10), which is what every tab, legend,
        // lane and table a task makes of it is named by — not the file's name,
        // which is only the default a map starts with.
        label: this.session.mapLabel(file.uri),
      }
    }
    for (const { map, panel } of this.session.deck.grid?.analysable() ?? []) {
      const facts = panel.analysisFacts()
      if (facts === null) {
        if (options.start) void panel.prepareAnalysis(() => this.workspace?.refresh())
        continue
      }
      out.push({
        map,
        uri: facts.uri,
        source: facts.source,
        ...cellsOfMap(facts.info),
        ...binningOfMap(facts.info),
        ...panel.resampleTarget(),
        label: this.session.mapLabel(facts.uri),
      })
    }
    // **In the grid's order**, the first map among the others where its cell
    // stands: a batch works through the maps as a reader reads the grid, and
    // the drawer's tabs and the all-maps figures and tables follow this list —
    // so a map moved on the Contact maps card moves there too (§16.9). The
    // companions still reading are left out, and the place is counted among the
    // maps that are in.
    if (lead !== null) {
      const before = this.session.deck.grid?.leadMapIndex ?? 0
      const ahead = (this.session.deck.grid?.analysable() ?? [])
        .slice(0, before)
        .filter(({ map }) => out.some((target) => target.map === map)).length
      out.splice(ahead, 0, lead)
    }
    return out
  }

  /** The file's circular declarations and origins, as a context carries them. */
  private declarations(): { circular: readonly string[]; origins: Record<string, number> } {
    return {
      circular: this.session.circularStore()?.list() ?? [],
      origins: this.session.originStore()?.record() ?? {},
    }
  }

  /**
   * What the panel prices and the form fills its dropdowns from.
   *
   * Rebuilt per call rather than held, and cheaply: it is a walk over the contig
   * table, and the alternative is a cached object that is wrong every time a
   * track is loaded or the map is panned. `analysis/context.ts` does the work.
   *
   * The starred map's, or — for a `task` that reads no map — the session's own
   * ({@link starredFacts}).
   */
  private context(task?: AnalysisTask): AnalysisContext | null {
    const file = this.session.file
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
      const assembly = this.session.assembly
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
        entries: this.session.annotations?.store.entries ?? [],
        framing: null,
        blockLoaded: false,
        blockBytes: 0,
        ...this.declarations(),
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
    const starred = this.starredFacts(task)
    const starredPanel = this.session.deck.grid?.starredPanel ?? null
    const info = starred?.info ?? file.info
    const uri = starred?.uri ?? file.uri
    const panel = starred === null ? this.session.current?.panel : (starredPanel?.map ?? undefined)
    // **At the resolution the reader added**, where the lead's map is drawn at
    // one (§3.4): every task on it reads the map summed to it, so it is priced,
    // and its bins counted, at that resolution rather than at the rung
    // underneath. Only with the map on screen — a link's `coarsen=` carried into
    // the browser draws no map at it, and the tracks there are binned as before.
    const derived = starred === null && panel !== undefined && panel !== null ? this.session.analysisGrid() : null
    const binsize = derived?.rung.binsize ?? info.binsize
    if (binsize === null || binsize <= 0) return null
    const declared = this.declarations()
    // The framing a task is **run** on, and so the one that has to carry the
    // declarations: the drawer's header was given them and the run was not, so
    // a circle ticked on the table was still measured as a line (§8.15).
    const framing = this.session.withEditOf(
      withCircularNames(
        panel === undefined || panel === null ? null : panel.analysisFraming(uri, derived),
        declared.circular,
        declared.origins,
      ),
    )
    const block = panel === undefined || panel === null || derived !== null ? null : panel.analysisBlock()
    return buildAnalysisContext({
      uri,
      layout: info.layout.kind,
      binsize,
      nBins: derived?.grid.nBins ?? info.nBins,
      hasGenomes: info.hasGenomes,
      hasWeights: info.hasWeights,
      scoreColumns: info.scoreColumns,
      contigs: starred === null ? (file.contigs?.table ?? null) : starred.contigs.table,
      genomes: starred === null ? file.genomes.table : (starred.genomes?.table ?? null),
      displayGenomes: starred === null ? file.genomes.display : (starred.genomes?.display ?? null),
      entries: this.session.annotations?.store.entries ?? [],
      framing,
      blockLoaded: block !== null,
      blockBytes: block === null ? 0 : block.values.byteLength,
      ...declared,
      // The cells of the map the star is on, not of the session's first file: a
      // deck can hold an `.scool` beside a `.cool`, and the per-cell task is
      // offered for whichever one an analysis would be measured against.
      cells: info.cells.length,
      activeCells: info.activeCells.length,
      // By name where a subset is ticked, so the command line the console and
      // the drawer write can say which cells the map was summed from.
      ...(info.cells.length > 0 && info.activeCells.length < info.cells.length
        ? { selectedCells: info.activeCells }
        : {}),
      resolutions: rungsOf(info.entries).map((rung) => rung.binsize),
      // Each at the resolution a run reads it at: on the lead at a resolution the
      // reader added, every map whose bins divide it is summed to it too (§3.4).
      peers: this.peersOf(uri).map((peer) =>
        derived !== null && peer.binsize > 0 && derived.rung.binsize % peer.binsize === 0
          ? { ...peer, binsize: derived.rung.binsize }
          : peer,
      ),
      // The starred map's import, where it was binned from a `.pairs`: Pairs QC
      // then has its counts already, and asks for no file (§18.8).
      ...(info.pairs === undefined
        ? {}
        : {
            binnedFrom: {
              name: fileBaseLabel(uri),
              orientation: info.pairs.orientation !== null,
            },
          }),
    })
  }

  /**
   * Put the workspace down — its worker, its drawer and any job it was
   * running — for a file, or a tab, that is going.
   */
  drop(): void {
    this.workspace?.destroy()
    this.workspace = null
  }
}
